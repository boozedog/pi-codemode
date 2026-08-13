// deno-bootstrap.ts — Deno sandbox bootstrap for codemode code execution.
//
// This file runs inside the Deno subprocess. It:
// 1. Sets up global proxies (codemode.*, print, π)
// 2. Handles JSON-RPC protocol over stdin/stdout
// 3. Executes user code and returns results
//
// Protocol: LSP-style Content-Length framing
// Request: Content-Length: N\r\n\r\n{...}
// Response: Content-Length: N\r\n\r\n{...}

// --- Types ---

interface ToolCallRequest {
  type: "tool_call";
  id: number;
  name: string;
  args: unknown;
}

interface ToolResultResponse {
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

interface RuntimeError {
  type: "runtime_error";
  error: {
    message: string;
    stack?: string;
  };
}

type ProtocolMessage =
  | ToolCallRequest
  | ToolResultResponse
  | LogMessage
  | DoneMessage
  | RuntimeError;

// --- State ---

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void }
>();
let nextId = 1;
let strings: Record<string, string> = {};
let jobArgs: Record<string, string> = {};

// --- Protocol I/O ---

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(msg: ProtocolMessage): void {
  const json = JSON.stringify(msg);
  const data = `Content-Length: ${json.length}\r\n\r\n${json}`;
  Deno.stdout.writeSync(encoder.encode(data));
}

async function* readMessages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ProtocolMessage> {
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse LSP-style framed messages
    while (true) {
      const headerMatch = buffer.match(/Content-Length:\s*(\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1], 10);
      const headerEnd = headerMatch.index! + headerMatch[0].length;
      const messageEnd = headerEnd + contentLength;

      if (buffer.length < messageEnd) break;

      const json = buffer.slice(headerEnd, messageEnd);
      buffer = buffer.slice(messageEnd);

      try {
        yield JSON.parse(json) as ProtocolMessage;
      } catch {
        // Invalid JSON - log and continue
        console.error("Invalid JSON in protocol message");
      }
    }
  }
}

// --- Tool Call Proxy ---

function callTool(name: string, args?: unknown): Promise<unknown> {
  const id = nextId++;
  send({ type: "tool_call", id, name, args: args ?? {} });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

// --- Global Setup ---

function setupGlobals(userStrings: Record<string, string>, userArgs: Record<string, string>): void {
  strings = Object.freeze(userStrings);
  jobArgs = Object.freeze(userArgs);

  // Create codemode proxy - all property accesses become tool calls
  (globalThis as any).codemode = new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop === "then") return undefined; // Prevent await detection
        return (args?: unknown) => callTool(prop, args);
      },
    },
  );

  (globalThis as any).read = (args?: unknown) => callTool("read", args);

  (globalThis as any).mcp = new Proxy(
    {},
    {
      get(_, namespace: string) {
        if (namespace === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_, tool: string) {
              if (tool === "then") return undefined;
              return (args?: unknown) => callTool(`mcp.${namespace}.${tool}`, args);
            },
          },
        );
      },
    },
  );

  (globalThis as any).cli = new Proxy(
    {},
    {
      get(_, tool: string) {
        if (tool === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_, operation: string) {
              if (operation === "then") return undefined;
              return async (args?: unknown) => {
                try {
                  return await callTool("cli.__call", {
                    tool: String(tool),
                    operation: String(operation),
                    args: args ?? {},
                  });
                } catch (err) {
                  if (
                    String((err as Error)?.message ?? err).includes('Tool "cli.__call" not found')
                  ) {
                    return callTool(`cli.${String(tool)}.${String(operation)}`, args ?? {});
                  }
                  throw err;
                }
              };
            },
          },
        );
      },
    },
  );

  // print() sends log messages to host
  (globalThis as any).print = (...args: unknown[]) => {
    send({ type: "log", level: "print", args });
  };

  // π contains the string constants
  (globalThis as any).π = strings;

  // args contains the job arguments
  (globalThis as any).args = jobArgs;

  // Override console methods to send to host
  console.log = (...args: unknown[]) => send({ type: "log", level: "log", args });
  console.warn = (...args: unknown[]) => send({ type: "log", level: "warn", args });
  console.error = (...args: unknown[]) => send({ type: "log", level: "error", args });
  console.info = (...args: unknown[]) => send({ type: "log", level: "log", args });
}

// --- Code Execution ---

async function executeCode(
  code: string,
  timeoutMs: number,
): Promise<{ result?: unknown; error?: string; logs: unknown[] }> {
  const logs: unknown[] = [];

  // Wrap code in an async IIFE. The IIFE must start on the same line as the
  // `return` below: a leading newline would trigger automatic semicolon
  // insertion and make `return` return `undefined` instead of the promise.
  const wrappedCode = `(async function() {\n${code}\n})()`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Use Function constructor for safer evaluation than eval.
    //
    // SECURITY: this runs arbitrary guest code in the same process as the
    // protocol handler. It is acceptable ONLY because the Deno subprocess
    // boundary plus the denied --allow-* permissions are the complete security
    // boundary. The parent process enforces a hard subprocess timeout because a
    // synchronous infinite loop blocks this event loop and defeats this timer.
    // Evaluate the async IIFE once and await its promise. The function body
    // returns the IIFE result, and the resulting function is called exactly
    // once.
    const fn = new Function("return " + wrappedCode);

    // Race against timeout. The timer is cleared in the finally block so the
    // child process does not linger after the code settles.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    const result = await Promise.race([fn(), timeout]);
    return { result, logs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { error, logs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Main Loop ---

async function main(): Promise<void> {
  // Read configuration from command line
  const args = Deno.args;
  const configArg = args.find((a) => a.startsWith("--config="));
  const config = configArg ? JSON.parse(configArg.slice(9)) : {};

  const { code, strings: userStrings, args: userArgs, timeoutMs = 120000 } = config;

  if (!code) {
    send({ type: "runtime_error", error: { message: "No code provided" } });
    return;
  }

  // Setup globals
  setupGlobals(userStrings || {}, userArgs || {});

  // Start response reader in background
  const reader = Deno.stdin.readable.getReader();
  void (async () => {
    try {
      for await (const msg of readMessages(reader)) {
        if (msg.type === "tool_result") {
          const { id, result, error } = msg as ToolResultResponse;
          const pendingCall = pending.get(id);
          if (pendingCall) {
            pending.delete(id);
            if (error) {
              pendingCall.reject(new Error(error));
            } else {
              pendingCall.resolve(result);
            }
          }
        }
      }
    } catch (err) {
      // Protocol error - reject all pending
      const error = err instanceof Error ? err : new Error(String(err));
      for (const [, { reject }] of pending) {
        reject(error);
      }
      pending.clear();
    }
  })();

  // Execute user code
  const { result, error } = await executeCode(code, timeoutMs);

  // Send result
  if (error) {
    send({ type: "done", error });
  } else {
    send({ type: "done", result });
  }

  // Exit deterministically so the child process does not linger (e.g. from a
  // background stdin reader or any stray timer).
  Deno.exit(0);
}

main().catch((err) => {
  send({
    type: "runtime_error",
    error: {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
  });
  Deno.exit(1);
});
