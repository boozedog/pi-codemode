// quickjs-executor.ts — Direct QuickJS sandbox executor.

import ts from "typescript";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { CodeExecutor, ExecuteResult, ExecutionProvider } from "./types.js";

type HostFn = (args: unknown) => unknown | Promise<unknown>;

export interface QuickJsExecutorOptions {
  /** Max execution time in ms (default: 120000 = 2 minutes) */
  timeout?: number;
  /** QuickJS heap limit in bytes (default: 64MiB) */
  memoryLimitBytes?: number;
}

export class QuickJsExecutor implements CodeExecutor {
  #timeout: number;
  #memoryLimitBytes: number;

  constructor(options: QuickJsExecutorOptions = {}) {
    this.#timeout = options.timeout ?? 120_000;
    this.#memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
  }

  async execute(
    code: string,
    providersOrFns: ExecutionProvider[] | Record<string, unknown>,
    options?: { strings?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ExecuteResult> {
    if (options?.signal?.aborted) {
      return { result: undefined, error: "Execution cancelled", logs: [] };
    }

    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    const runtime = vm.runtime;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.#timeout));
    runtime.setMemoryLimit(this.#memoryLimitBytes);
    const logs: string[] = [];
    const resolveHostFn = createHostFnResolver(providersOrFns);
    const pendingHostPromises = new Set<{
      reject: (handle?: any) => void;
      dispose: () => void;
      alive?: boolean;
    }>();
    const hostTasks = new Set<Promise<void>>();
    let closing = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let activePromiseHandle: { alive?: boolean; dispose: () => void } | undefined;
    let pendingResolution: Promise<any> | undefined;

    try {
      const global = vm.global;
      const cancellation = new Promise<never>((_, reject) => {
        abortHandler = () => {
          cancelled = true;
          reject(new Error("Execution cancelled"));
        };
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
      });

      const hostCall = vm.newFunction("__hostCall", (nameHandle, argsHandle) => {
        const name = vm.getString(nameHandle);
        const args = vm.dump(argsHandle);
        const promise = vm.newPromise();
        pendingHostPromises.add(promise);
        promise.settled.then(() => pendingHostPromises.delete(promise));
        const fn = resolveHostFn(name);

        if (!fn) {
          const errorHandle = vm.newError(`Tool "${name}" not found`);
          promise.reject(errorHandle);
          errorHandle.dispose();
          promise.settled.then(runtime.executePendingJobs);
          return promise.handle;
        }

        const task = Promise.resolve()
          .then(() => fn(args))
          .then((result) => {
            if (closing || promise.alive === false) return;
            const handle = newJsonHandle(vm, result);
            promise.resolve(handle);
            handle.dispose();
          })
          .catch((err) => {
            if (closing || promise.alive === false) return;
            const message = err instanceof Error ? err.message : String(err);
            const errorHandle = vm.newError(message);
            promise.reject(errorHandle);
            errorHandle.dispose();
          })
          .finally(() => {
            if (!closing) void runtime.executePendingJobs();
          });
        hostTasks.add(task);
        task.finally(() => hostTasks.delete(task));

        return promise.handle;
      });
      vm.setProp(global, "__hostCall", hostCall);
      hostCall.dispose();

      const print = vm.newFunction("print", (...args) => {
        logs.push(args.map((arg) => formatDump(vm.dump(arg))).join(" "));
      });
      vm.setProp(global, "print", print);
      print.dispose();

      const strings = newJsonHandle(vm, options?.strings ?? {});
      vm.setProp(global, "π", strings);
      strings.dispose();

      const setup = vm.evalCode(`
				globalThis.codemode = new Proxy({}, {
					get(_target, prop) {
						if (prop === 'then') return undefined;
						if (prop === 'read' || prop === 'write' || prop === 'replace_in_file' || prop === 'apply_patch') return undefined;
						return new Proxy(function(args) { return globalThis.__hostCall(String(prop), args ?? {}); }, {
							get(_fnTarget, child) {
								if (child === 'then') return undefined;
								return function(args) { return globalThis.__hostCall(String(prop) + '.' + String(child), args ?? {}); };
							}
						});
					}
				});
				globalThis.read = function(args) { return globalThis.__hostCall('read', args ?? {}); };
				globalThis.write = function(args) { return globalThis.__hostCall('write', args ?? {}); };
				globalThis.replace_in_file = function(args) { return globalThis.__hostCall('replace_in_file', args ?? {}); };
				globalThis.apply_patch = function(args) { return globalThis.__hostCall('apply_patch', args ?? {}); };
				globalThis.cli = new Proxy({}, {
					get(_target, tool) {
						if (tool === 'then') return undefined;
						return new Proxy({}, {
							get(_toolTarget, operation) {
								if (operation === 'then') return undefined;
								return async function(args) {
									try {
										return await globalThis.__hostCall('cli.__call', { tool: String(tool), operation: String(operation), args: args ?? {} });
									} catch (err) {
										if (String(err && err.message || err).includes('Tool "cli.__call" not found')) {
											return globalThis.__hostCall('cli.' + String(tool) + '.' + String(operation), args ?? {});
										}
										throw err;
									}
								};
							}
						});
					}
				});
				globalThis.console = { log: print, info: print, warn: print, error: print };
			`);
      if (setup.error) {
        const err = vm.dump(setup.error);
        setup.error.dispose();
        return { result: undefined, error: formatDump(err), logs };
      }
      setup.value.dispose();

      const js = transpileUserCode(code);
      const wrapped = `(async function() {\n${js}\n})()`;
      const evalResult = vm.evalCode(wrapped, "codemode.js");
      void runtime.executePendingJobs();
      if (evalResult.error) {
        const err = vm.dump(evalResult.error);
        evalResult.error.dispose();
        return {
          result: undefined,
          error: normalizeRuntimeError(formatDump(err), this.#timeout),
          logs,
        };
      }

      const promiseHandle = evalResult.value;
      activePromiseHandle = promiseHandle;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Execution timed out after ${this.#timeout}ms`));
        }, this.#timeout);
      });
      pendingResolution = resolveQuickJsPromise(vm, runtime, promiseHandle);
      const resolved = await Promise.race([pendingResolution, timeout, cancellation]);
      promiseHandle.dispose();
      activePromiseHandle = undefined;

      if (resolved.error) {
        const err = vm.dump(resolved.error);
        resolved.error.dispose();
        return {
          result: undefined,
          error: normalizeRuntimeError(formatDump(err), this.#timeout),
          logs,
        };
      }

      const result = vm.dump(resolved.value);
      resolved.value.dispose();
      return { result, logs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: undefined, error: cancelled ? "Execution cancelled" : message, logs };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
      if (!timedOut && !cancelled && hostTasks.size > 0) {
        await Promise.allSettled(hostTasks);
        void runtime.executePendingJobs();
      }
      closing = true;
      if (timedOut || cancelled) {
        const errorHandle = vm.newError(
          cancelled ? "Execution cancelled" : `Execution timed out after ${this.#timeout}ms`,
        );
        for (const promise of pendingHostPromises) {
          promise.reject(errorHandle);
        }
        errorHandle.dispose();
        void runtime.executePendingJobs();
        await new Promise((resolve) => setImmediate(resolve));
        void runtime.executePendingJobs();
        const settled = await pendingResolution?.catch(() => undefined);
        if (settled?.error) settled.error.dispose();
        if (settled?.value) settled.value.dispose();
        for (const promise of pendingHostPromises) {
          if (promise.alive !== false) promise.dispose();
        }
        pendingHostPromises.clear();
      }
      if (activePromiseHandle?.alive !== false) {
        activePromiseHandle?.dispose();
        activePromiseHandle = undefined;
      }
      const cleanup = vm.evalCode(`
        globalThis.__hostCall = undefined;
        globalThis.read = undefined;
        globalThis.write = undefined;
        globalThis.replace_in_file = undefined;
        globalThis.codemode = undefined;
        globalThis.cli = undefined;
        globalThis.print = undefined;
        globalThis.console = undefined;
        globalThis.π = undefined;
      `);
      if (cleanup.error) cleanup.error.dispose();
      else cleanup.value.dispose();
      void runtime.executePendingJobs();
      vm.dispose();
    }
  }
}

function transpileUserCode(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

function createHostFnResolver(
  providersOrFns: ExecutionProvider[] | Record<string, unknown>,
): (name: string) => HostFn | undefined {
  const roots = Array.isArray(providersOrFns)
    ? Object.fromEntries(providersOrFns.map((provider) => [provider.name, provider.fns]))
    : { codemode: providersOrFns };
  const codemodeRoot = roots.codemode;

  return (name: string): HostFn | undefined => {
    const namespaced = resolvePath(roots, name);
    if (namespaced) return namespaced;

    // File tools and discovery helpers are exposed as top-level functions but are backed by
    // the codemode provider. Resolve dynamically so Proxy-backed MCP namespaces with no cached
    // tool names can still handle calls such as context7.resolve_library_id.
    return resolvePath(codemodeRoot, name);
  };
}

function resolvePath(root: unknown, path: string): HostFn | undefined {
  let current = root;
  for (const part of path.split(".")) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "function" ? (current as HostFn) : undefined;
}

async function resolveQuickJsPromise(
  vm: { resolvePromise: (handle: any) => Promise<any> },
  runtime: { executePendingJobs: () => unknown },
  promiseHandle: any,
): Promise<any> {
  const resolved = vm.resolvePromise(promiseHandle);
  let done = false;
  resolved.finally(() => {
    done = true;
  });
  while (!done) {
    await runtime.executePendingJobs();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return resolved;
}

function newJsonHandle(
  vm: {
    evalCode: (code: string) => any;
    unwrapResult: (result: any) => any;
    undefined: any;
  },
  value: unknown,
): any {
  if (value === undefined) return vm.undefined;
  return vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`));
}

function normalizeRuntimeError(error: string, timeoutMs: number): string {
  if (/"name":"InternalError"/.test(error) && /"message":"interrupted"/.test(error)) {
    return `Execution timed out after ${timeoutMs}ms`;
  }
  return error;
}

function formatDump(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
