import cp, { ChildProcess } from "child_process";
import { Server, Socket } from "net";
import signalExit from "signal-exit";

/* istanbul ignore next */
function noop() {
}

interface ReadableStreamLike {
  pipe(destination: any, options?: any): any;

  unpipe(destination: any): any;
}

/**
 * Interface representing a parent process.
 *
 * This interface is compatible with the global variable `process`.
 */
interface ProcessLike {
  pid: number;
  stdout: any;
  stderr: any;
  stdin: ReadableStreamLike;

  exit(code?: number): any;

  kill(pid: number, signal?: string | number): any;

  on(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): any;

  on(event: "message", listener: (message: any, sendHandle: Socket | Server) => void): any;

  on(event: "exit", listener: NodeJS.ExitListener): any;

  removeListener(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): any;

  removeListener(event: "message", listener: (message: any, sendHandle: Socket | Server) => void): any;

  removeListener(event: "exit", listener: NodeJS.ExitListener): any;

  send?(message: any, sendHandle?: any): void;
}

/**
 * This function closes the parent process like the child process:
 * - If the child was killed by a signal, it kills the parent with this signal.
 * - If the child has exited, it exits the parent with the same return code.
 */
interface CloseFn {
  (): void;

  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Proxies `child` through `parent`.
 *
 * Any signal, IPC message or stream IO on the parent will be passed to the
 * child.
 * The returned promise is resolved once the child is closed.
 * The value is a close function to close the parent process the same way as
 * the child was closed.
 *
 * @param parent Parent process.
 * @param child Child process.
 * @return Close function to close the parent function like the child process.
 */
async function proxy(parent: ProcessLike, child: cp.ChildProcess): Promise<CloseFn> {
  return new Promise<CloseFn>((resolve, reject) => {
    const unproxySignals: UnproxySignals = proxySignals(parent, child);
    const unproxyStreams: UnproxyStreams = proxyStreams(parent, child);
    const unproxyMessages: UnproxyMessages = proxyMessages(parent, child);

    parent.on("exit", onParentExit);
    child.on("close", onClose);

    function onParentExit() {
      child.kill("SIGHUP");
    }

    function onClose(code: number | null, signal: NodeJS.Signals | null) {
      unproxyMessages();
      unproxyStreams();
      unproxySignals();
      parent.removeListener("exit", onParentExit);
      resolve(Object.assign(
        () => {
          if (signal !== null) {
            /* istanbul ignore next */
            if (parent === process) {
              // If there is nothing else keeping the event loop alive,
              // then there's a race between a graceful exit and getting
              // the signal to this process.  Put this timeout here to
              // make sure we're still alive to get the signal, and thus
              // exit with the intended signal code.
              setTimeout(noop, 200);
            }
            parent.kill(parent.pid, signal);
          } else {
            parent.exit(code!);
          }
        },
        {code, signal},
      ));
    }
  });
}

/**
 * Spawn options, with additional values specific to `foreground-child`.
 *
 * Note: The default value for `stdio` is `inherit` (as opposed to `pipe` in
 * Node's `spawn`).
 */
interface SpawnOptions extends cp.SpawnOptions {
  /**
   * Parent process to use.
   *
   * Default: `process` (global variable).
   */
  parent?: ProcessLike;

  /**
   * Spawn function to use.
   *
   * You can supply your own spawn function.
   * For example, you can use `cross-spawn` or a `spawn-wrap` function.
   *
   * Default: `require("child_process").spawn`
   */
  spawn?: typeof cp.spawn;
}

interface SpawnResult {
  /**
   * Proxied child process
   */
  child: ChildProcess;

  /**
   * Promise resolved once the child is closed.
   *
   * The value is a "close function" that closes the parent process the same
   * way as the child was closed.
   */
  close: Promise<CloseFn>;
}

/**
 * Spawns a new proxied child process.
 *
 * IO, IPC and signals from the parent process are forwarded to the child process.
 * By default, it uses the global `process` variable as the parent, effectively
 * moving control to the child process.
 *
 * @param file File to spawn
 * @param args Process arguments
 * @param options Spawn options. The options are similar to the ones of Node's
 *   `spawn` function, with additional options specific to `foreground-child`.
 *   See [[SpawnOptions]]. The default value for `stdio` is `inherit` (as opposed
 *   to `pipe` in Node's `spawn`).
 * @return The proxied child process and a promise for the close function.
 */
function spawn(file: string, args?: ReadonlyArray<string>, options?: SpawnOptions): SpawnResult {
  if (args === undefined) {
    args = [];
  }
  if (options === undefined) {
    options = {};
  }
  const parent: ProcessLike = options.parent !== undefined ? options.parent : process;
  const spawn: typeof cp.spawn = options.spawn !== undefined ? options.spawn : cp.spawn;
  const spawnOptions: SpawnOptions = {
    ...options,
    stdio: getStdio(options.stdio, parent.send !== undefined),
    parent: undefined,
    spawn: undefined,
  };
  const child: ChildProcess = spawn(file, args, spawnOptions);
  const close = proxy(parent, child);
  return {child, close};
}

/**
 * Returns an `stdio` value compatible with IPC forwarding.
 *
 * The default value for `base` is `inherit`, as opposed to `pipe` in Node's
 * `spawn`.
 * If `withIpc` is false, the input value is returned as is.
 * Otherwise, it ensures that the `ipc` channel is present (adding it at the end if missing).
 *
 * @param base base value of `stdio`.
 * @param withIpc Boolean indicating if the `ipc` channel should be present.
 * @return Normalized `stdio` value.
 */
function getStdio(base: cp.StdioOptions | undefined, withIpc: boolean): cp.StdioOptions {
  if (base === undefined) {
    // Use Node's default value.
    base = "inherit";
  }
  if (!withIpc) {
    return base;
  } else if (typeof base === "string") {
    return [base, base, base, "ipc"];
  } else if (base.indexOf("ipc") < 0) {
    return [...base, "ipc"];
  } else {
    return base;
  }
}

/**
 * @internal
 */
type CloseHandler = (done: CloseFn) => any;

/**
 * @internal
 */
interface NormalizedArguments {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly cb: CloseHandler;
}

/**
 * Normalizes the arguments passed to `foregroundChild`.
 *
 * See the signature of `foregroundChild` for the supported arguments.
 *
 * @param a Array of arguments passed to `foregroundChild`.
 * @return Normalized arguments
 * @internal
 */
function normalizeArguments(a: any[]): NormalizedArguments {
  let program: string;
  let args: ReadonlyArray<string>;
  let cb: CloseHandler;

  let processArgsEnd: number = a.length;
  const lastArg: any = a[a.length - 1];
  if (typeof lastArg === "function") {
    cb = lastArg;
    processArgsEnd--;
  } else {
    cb = (done: CloseFn) => done();
  }

  if (Array.isArray(a[0])) {
    [program, ...args] = a[0];
  } else {
    program = a[0];
    args = Array.isArray(a[1]) ? a[1] : a.slice(1, processArgsEnd);
  }

  return {program, args, cb};
}

// tslint:disable:max-line-length
function foregroundChild(program: string | ReadonlyArray<string>, cb?: CloseHandler): cp.ChildProcess;
function foregroundChild(program: string, args: ReadonlyArray<string>, cb?: CloseHandler): cp.ChildProcess;
function foregroundChild(program: string, arg1: string, cb?: CloseHandler): cp.ChildProcess;
function foregroundChild(program: string, arg1: string, arg2: string, cb?: CloseHandler): cp.ChildProcess;
function foregroundChild(program: string, arg1: string, arg2: string, arg3: string, cb?: CloseHandler): cp.ChildProcess;
function foregroundChild(program: string, arg1: string, arg2: string, arg3: string, arg4: string, cb?: CloseHandler): cp.ChildProcess;
// tslint:enable
/**
 * Original `foregroundChild` function.
 *
 * It is exposed as the main CJS export or as the `compat` named function.
 *
 * @deprecated
 */
function foregroundChild(...a: any[]): any {
  /* istanbul ignore next */
  const simpleSpawn = process.platform === "win32" ? require("cross-spawn") : require("child_process").spawn;
  const {program, args, cb} = normalizeArguments(a);

  const spawnOpts: cp.SpawnOptions = {
    stdio: getStdio("inherit", process.send !== undefined),
  };

  const child: cp.ChildProcess = simpleSpawn(program, args, spawnOpts);

  if (process.send !== undefined) {
    process.removeAllListeners("message");
  }
  const unproxySignals: UnproxySignals = proxySignals(process, child);
  const unproxyMessages: UnproxyMessages = proxyMessages(process, child);

  process.on("exit", childHangup);

  function childHangup() {
    child.kill("SIGHUP");
  }

  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    // Allow the callback to inspect the child’s exit code and/or modify it.
    process.exitCode = signal ? 128 + signal : code as any;

    cb(Object.assign(
      () => {
        unproxySignals();
        process.removeListener("exit", childHangup);
        if (signal) {
          // If there is nothing else keeping the event loop alive,
          // then there's a race between a graceful exit and getting
          // the signal to this process.  Put this timeout here to
          // make sure we're still alive to get the signal, and thus
          // exit with the intended signal code.
          setTimeout(noop, 200);
          process.kill(process.pid, signal);
        } else {
          // Equivalent to process.exit() on Node.js >= 0.11.8
          process.exit(process.exitCode);
        }
      },
      {code, signal},
    ));
  });

  return child;
}

/**
 * @internal
 */
type UnproxySignals = () => void;

/**
 * @internal
 */
function proxySignals(parent: ProcessLike, child: cp.ChildProcess): UnproxySignals {
  const listeners: Map<NodeJS.Signals, NodeJS.SignalsListener> = new Map();

  for (const sig of signalExit.signals()) {
    const listener: NodeJS.SignalsListener = () => child.kill(sig);
    listeners.set(sig, listener);
    parent.on(sig, listener);
  }

  return unproxySignals;

  function unproxySignals(): void {
    for (const [sig, listener] of listeners) {
      parent.removeListener(sig, listener);
    }
  }
}

/**
 * @internal
 */
type UnproxyMessages = () => void;

/**
 * @internal
 */
function proxyMessages(parent: ProcessLike, child: cp.ChildProcess): UnproxyMessages {
  if (parent.send === undefined) {
    return noop;
  }

  function childListener(message: any, sendHandle: Socket | Server): void {
    parent.send!(message, sendHandle);
  }

  function parentListener(message: any, sendHandle: Socket | Server): void {
    child.send(message, sendHandle);
  }

  child.on("message", childListener);
  parent.on("message", parentListener);

  return unproxySignals;

  function unproxySignals(): void {
    child.removeListener("message", childListener);
    parent.removeListener("message", parentListener);
  }
}

/**
 * @internal
 */
type UnproxyStreams = () => void;

/**
 * @internal
 */
function proxyStreams(parent: ProcessLike, child: cp.ChildProcess): UnproxyStreams {
  if (typeof child.stdout === "object" && child.stdout !== null) {
    child.stdout.pipe(parent.stdout);
  }
  if (typeof child.stderr === "object" && child.stderr !== null) {
    child.stderr.pipe(parent.stderr);
  }
  if (typeof child.stdin === "object" && child.stdin !== null) {
    parent.stdin.pipe(child.stdin);
  }

  return unproxyStreams;

  function unproxyStreams(): void {
    if (typeof child.stdout === "object" && child.stdout !== null) {
      child.stdout.unpipe(parent.stdout);
    }
    if (typeof child.stderr === "object" && child.stderr !== null) {
      child.stderr.unpipe(parent.stderr);
    }
    if (typeof child.stdin === "object" && child.stdin !== null) {
      parent.stdin.unpipe(child.stdin);
    }
  }
}

// These TS exports are only there to generate the type definitions, they will be overwritten by the CJS exports below
export {
  CloseHandler,
  CloseFn,
  ProcessLike,
  ReadableStreamLike,
  SpawnOptions,
  SpawnResult,
  foregroundChild as compat,
  proxy,
  spawn,
};

module.exports = foregroundChild;
Object.assign(module.exports, {
  compat: foregroundChild,
  proxy,
  spawn,
});
