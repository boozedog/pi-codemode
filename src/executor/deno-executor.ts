// deno-executor.ts — Deno sandbox executor implementation.
//
// Implements the CodeExecutor interface for local Deno execution. Manages the
// Deno subprocess, the LSP-style framed JSON protocol, and tool call dispatch.
//
// Security model: Deno is deny-by-default, so the subprocess is spawned with no
// --allow-* flags except --allow-read, which grants access ONLY to the generated
// bootstrap entrypoint (Deno needs to read the main module to run at all). The
// subprocess boundary plus the denied permissions are the complete security
// boundary for guest code; the parent process enforces a hard timeout that kills
// the whole process group so runaway code cannot leave children behind. QuickJS
// remains the recommended/default executor.
import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostFnResolver } from "./resolve-host-fn.js";
import type { CodeExecutor, ExecuteResult, ExecutionProvider } from "./types.js";

export interface DenoExecutorOptions {
  /** Max execution time in ms (default: 120000 = 2 minutes) */
  timeout?: number;
  /** Deno executable path (default: "deno") */
  denoPath?: string;
}

// Protocol types
interface ToolCallMessage {
  type: "tool_call";
  id: number;
  name: string;
  args: unknown;
}

interface ToolResultMessage {
  type: "tool_result";
  id: number;
  result?: unknown;
  error?: string;
}

interface LogMessage {
  type: "log";
  level: "print" | "log" | "warn" | "error";
  args: unknown[];
}

interface DoneMessage {
  type: "done";
  result?: unknown;
  error?: string;
}

interface RuntimeErrorMessage {
  type: "runtime_error";
  error: { message: string; stack?: string };
}

type ProtocolMessage =
  | ToolCallMessage
  | ToolResultMessage
  | LogMessage
  | DoneMessage
  | RuntimeErrorMessage;

type ChildProcess = ReturnType<typeof spawn>;
type HostFn = (args: unknown) => unknown | Promise<unknown>;

/**
 * Deno sandbox executor.
 *
 * Runs generated code in a Deno subprocess with all permissions denied (except
 * reading the bootstrap entrypoint), communicating via framed JSON over
 * stdin/stdout.
 */
export class DenoExecutor implements CodeExecutor {
  #timeout: number;
  #denoPath: string;
  #bootstrapPath: string | null = null;

  constructor(options: DenoExecutorOptions = {}) {
    this.#timeout = options.timeout ?? 120_000;
    this.#denoPath = options.denoPath ?? "deno";
  }

  /**
   * Initialize the executor by writing the bootstrap file.
   */
  async init(): Promise<void> {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-codemode-"));
    this.#bootstrapPath = join(tmpDir, "deno-bootstrap.ts");
    const bootstrapSource = await this.#getBootstrapSource();
    await writeFile(this.#bootstrapPath, bootstrapSource, "utf-8");
  }

  /**
   * Execute code in the Deno sandbox.
   */
  async execute(
    code: string,
    providersOrFns: ExecutionProvider[] | Record<string, unknown>,
    options?: {
      strings?: Record<string, string>;
      args?: Readonly<Partial<Record<string, string>>>;
      signal?: AbortSignal;
    },
  ): Promise<ExecuteResult> {
    if (!this.#bootstrapPath) {
      await this.init();
    }
    if (options?.signal?.aborted) {
      return { result: undefined, error: "Execution cancelled", logs: [] };
    }

    const resolveHostFn = createHostFnResolver(providersOrFns);

    const config = {
      code,
      strings: options?.strings ?? {},
      args: options?.args ?? {},
      timeoutMs: this.#timeout,
    };

    const args = [
      "run",
      "--quiet",
      "--no-prompt",
      // Deno is deny-by-default: no --allow-* flags means no filesystem, network,
      // environment, subprocess, system, or FFI access. The only exception is
      // reading the bootstrap entrypoint itself, which Deno requires to load the
      // main module. Granting only this one path keeps the rest denied.
      `--allow-read=${this.#bootstrapPath}`,
      this.#bootstrapPath!,
      `--config=${JSON.stringify(config)}`,
    ];

    // detached: true puts the child in its own process group so the parent can
    // kill the whole group (including any grandchildren) on timeout/cancel.
    const child = spawn(this.#denoPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const logs: string[] = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    return new Promise<ExecuteResult>((resolve, reject) => {
      const killGroup = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          // Process group already gone.
        }
      };

      const cleanup = (): void => {
        if (timeoutId) clearTimeout(timeoutId);
        if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
      };

      const finish = (result: ExecuteResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Ensure no child process lingers after completion.
        killGroup();
        resolve(result);
      };

      // Hard parent timeout: the authoritative kill switch for runaway code.
      // A synchronous infinite loop blocks the Deno event loop, so the
      // bootstrap-level timer cannot interrupt it; only this parent timeout can.
      timeoutId = setTimeout(() => {
        finish({
          result: undefined,
          error: `Execution timed out after ${this.#timeout}ms`,
          logs,
        });
      }, this.#timeout);

      if (options?.signal) {
        abortHandler = () => {
          finish({ result: undefined, error: "Execution cancelled", logs });
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      child.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString("utf-8");

        // Parse LSP-style framed messages.
        while (true) {
          const headerMatch = stdoutBuffer.match(/Content-Length:\s*(\d+)\r\n\r\n/);
          if (!headerMatch) break;

          const contentLength = parseInt(headerMatch[1], 10);
          const headerEnd = headerMatch.index! + headerMatch[0].length;
          const messageEnd = headerEnd + contentLength;

          if (stdoutBuffer.length < messageEnd) break;

          const json = stdoutBuffer.slice(headerEnd, messageEnd);
          stdoutBuffer = stdoutBuffer.slice(messageEnd);

          try {
            const msg = JSON.parse(json) as ProtocolMessage;
            this.#handleMessage(msg, resolveHostFn, logs, child, finish);
          } catch {
            // Invalid JSON - ignore.
          }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderrBuffer += data.toString("utf-8");
      });

      child.on("exit", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({
            result: undefined,
            error: stderrBuffer || `Deno process exited with code ${code}`,
            logs,
          });
        } else {
          // Exit 0 without a done message should not happen; treat as an error.
          finish({ result: undefined, error: "Deno process exited without a result", logs });
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        // A spawn failure (e.g. ENOENT when the Deno binary is missing) is a
        // configuration error, not an execution result. Reject so the caller
        // can report that the configured executor is unavailable.
        reject(err);
      });
    });
  }

  /**
   * Handle a protocol message from the Deno process.
   */
  #handleMessage(
    msg: ProtocolMessage,
    resolveHostFn: (name: string) => HostFn | undefined,
    logs: string[],
    child: ChildProcess,
    finish: (result: ExecuteResult) => void,
  ): void {
    switch (msg.type) {
      case "tool_call": {
        const { id, name, args } = msg;
        const fn = resolveHostFn(name);

        if (!fn) {
          this.#sendToChild(child, {
            type: "tool_result",
            id,
            error: `Tool "${name}" not found`,
          });
          return;
        }

        Promise.resolve(fn(args))
          .then((result) => {
            this.#sendToChild(child, { type: "tool_result", id, result });
          })
          .catch((err) => {
            const error = err instanceof Error ? err.message : String(err);
            this.#sendToChild(child, { type: "tool_result", id, error });
          });
        break;
      }

      case "log": {
        const logLine = msg.args
          .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
          .join(" ");
        logs.push(logLine);
        break;
      }

      case "done": {
        // The done message is the authoritative completion signal.
        if (msg.error) {
          finish({ result: undefined, error: msg.error, logs });
        } else {
          finish({ result: msg.result, logs });
        }
        break;
      }

      case "runtime_error": {
        finish({ result: undefined, error: msg.error.message, logs });
        break;
      }
    }
  }

  /**
   * Send a message to the Deno child process.
   */
  #sendToChild(child: ChildProcess, msg: ProtocolMessage): void {
    const json = JSON.stringify(msg);
    const data = `Content-Length: ${json.length}\r\n\r\n${json}`;
    child.stdin?.write(data);
  }

  /**
   * Get the bootstrap source code.
   * In production, this would read from a bundled file.
   */
  async #getBootstrapSource(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    try {
      // In built packages, TypeScript emits deno-bootstrap.js next to this file.
      return await readFile(join(__dirname, "deno-bootstrap.js"), "utf-8");
    } catch {
      // In source/test runs, the .ts file may be available.
      return readFile(join(__dirname, "deno-bootstrap.ts"), "utf-8");
    }
  }

  /**
   * Cleanup resources.
   */
  async shutdown(): Promise<void> {
    if (this.#bootstrapPath) {
      try {
        await unlink(this.#bootstrapPath);
      } catch {
        // Ignore cleanup errors.
      }
      this.#bootstrapPath = null;
    }
  }
}
