// types.ts — Shared executor interfaces.

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface ExecutionProvider {
  name: string;
  fns: Record<string, unknown>;
}

export interface CodeExecutor {
  init?(): Promise<void>;
  execute(
    code: string,
    providersOrFns: ExecutionProvider[] | Record<string, unknown>,
    options?: { strings?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ExecuteResult>;
  shutdown?(): Promise<void>;
}
