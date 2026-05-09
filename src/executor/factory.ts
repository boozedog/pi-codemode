// factory.ts — Executor selection.

import { DenoExecutor, type DenoExecutorOptions } from "./deno-executor.js";
import { QuickJsExecutor, type QuickJsExecutorOptions } from "./quickjs-executor.js";
import type { CodeExecutor } from "./types.js";

export type ExecutorKind = "quickjs" | "deno";

export interface ExecutorFactoryOptions {
  /** Defaults to QuickJS for the MVP. Deno is optional/future. */
  kind?: ExecutorKind;
  timeout?: number;
  quickjs?: Omit<QuickJsExecutorOptions, "timeout">;
  deno?: Omit<DenoExecutorOptions, "timeout">;
}

export function createExecutor(options: ExecutorFactoryOptions = {}): CodeExecutor {
  const kind = options.kind ?? "quickjs";

  switch (kind) {
    case "quickjs":
      return new QuickJsExecutor({ timeout: options.timeout, ...options.quickjs });
    case "deno":
      return new DenoExecutor({ timeout: options.timeout, ...options.deno });
  }
}
