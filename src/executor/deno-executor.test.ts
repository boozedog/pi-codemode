import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { DenoExecutor } from "./deno-executor.js";

function frame(msg: unknown): string {
  const json = JSON.stringify(msg);
  return `Content-Length: ${json.length}\r\n\r\n${json}`;
}

function createFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = {
    write: vi.fn<(chunk: string) => boolean>(),
    end: vi.fn<() => void>(),
  };
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    kill: vi.fn<(signal?: string) => boolean>(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
  };
  return child;
}

function parseFrames(writes: string[]): unknown[] {
  const messages: unknown[] = [];
  for (const w of writes) {
    const m = w.match(/Content-Length:\s*(\d+)\r\n\r\n/);
    if (!m) continue;
    const len = parseInt(m[1], 10);
    const start = m.index! + m[0].length;
    messages.push(JSON.parse(w.slice(start, start + len)));
  }
  return messages;
}

describe("DenoExecutor", () => {
  let executor: DenoExecutor;

  beforeEach(() => {
    executor = new DenoExecutor({ timeout: 5_000 });
    mockSpawn.mockReset();
  });

  afterEach(async () => {
    await executor.shutdown();
  });

  test("resolves a successful execution via the done message", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("return 42;", [{ name: "codemode", fns: {} }]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.emit("data", Buffer.from(frame({ type: "done", result: 42 })));
    const result = await resultPromise;

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  test("resolves an error via the done message", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("throw new Error('boom');", [
      { name: "codemode", fns: {} },
    ]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.emit("data", Buffer.from(frame({ type: "done", error: "boom" })));
    const result = await resultPromise;

    expect(result.error).toBe("boom");
    expect(result.result).toBeUndefined();
  });

  test("resolves a runtime_error message", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("return 1;", [{ name: "codemode", fns: {} }]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.emit(
      "data",
      Buffer.from(frame({ type: "runtime_error", error: { message: "No code provided" } })),
    );
    const result = await resultPromise;

    expect(result.error).toBe("No code provided");
  });

  test("dispatches tool calls and sends results back", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const calls: unknown[] = [];
    const resultPromise = executor.execute("await codemode.echo({});", [
      {
        name: "codemode",
        fns: {
          echo: async (a: unknown) => {
            calls.push(a);
            return { echoed: a };
          },
        },
      },
    ]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.emit(
      "data",
      Buffer.from(frame({ type: "tool_call", id: 1, name: "codemode.echo", args: { x: 1 } })),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled());

    const sent = parseFrames(child.stdin.write.mock.calls.map((c) => c[0]));
    expect(sent).toEqual([{ type: "tool_result", id: 1, result: { echoed: { x: 1 } } }]);

    child.stdout.emit("data", Buffer.from(frame({ type: "done", result: "ok" })));
    const result = await resultPromise;
    expect(result.result).toBe("ok");
  });

  test("sends a tool not found error for unknown tools", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("await codemode.nope({});", [
      { name: "codemode", fns: {} },
    ]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.emit(
      "data",
      Buffer.from(frame({ type: "tool_call", id: 7, name: "codemode.nope", args: {} })),
    );
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled());

    const sent = parseFrames(child.stdin.write.mock.calls.map((c) => c[0]));
    expect(sent).toEqual([{ type: "tool_result", id: 7, error: 'Tool "codemode.nope" not found' }]);

    child.stdout.emit("data", Buffer.from(frame({ type: "done", result: "ok" })));
    await resultPromise;
  });

  test("threads strings and args into the bootstrap config", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("return 1;", [{ name: "codemode", fns: {} }], {
      strings: { name: "deno" },
      args: { date: "2026-08-13" },
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const configArg = args.find((a) => a.startsWith("--config="));
    const config = JSON.parse(configArg!.slice("--config=".length));
    expect(config.strings).toEqual({ name: "deno" });
    expect(config.args).toEqual({ date: "2026-08-13" });

    child.stdout.emit("data", Buffer.from(frame({ type: "done", result: 1 })));
    await resultPromise;
  });

  test("spawns deny-by-default with read access only to the bootstrap", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("return 1;", [{ name: "codemode", fns: {} }]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const [denoPath, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(denoPath).toBe("deno");
    // Deno is deny-by-default: no --allow-* flags (other than the bootstrap
    // read) means filesystem, network, env, subprocess, system, and FFI stay
    // denied. Assert no empty --allow-* flags are passed.
    const allowFlags = args.filter((a) => a.startsWith("--allow-"));
    expect(allowFlags).toHaveLength(1);
    const readFlag = args.find((a) => a.startsWith("--allow-read="));
    expect(readFlag).toBeDefined();
    expect(readFlag).not.toBe("--allow-read=");
    expect(readFlag).toMatch(/^--allow-read=\/tmp\/pi-codemode-/);

    child.stdout.emit("data", Buffer.from(frame({ type: "done", result: 1 })));
    await resultPromise;
  });

  test("times out runaway code and kills the process group", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fast = new DenoExecutor({ timeout: 50 });
    const resultPromise = fast.execute("while (true) {}", [{ name: "codemode", fns: {} }]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const result = await resultPromise;
    expect(result.error).toMatch(/timed out/i);
    expect(result.result).toBeUndefined();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
    await fast.shutdown();
  });

  test("cancels on signal abort and kills the process group", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    const resultPromise = executor.execute(
      "await codemode.never({});",
      [{ name: "codemode", fns: { never: () => new Promise(() => {}) } }],
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    setImmediate(() => controller.abort());
    const result = await resultPromise;
    expect(result.error).toBe("Execution cancelled");
    expect(result.result).toBeUndefined();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
  });

  test("does not spawn when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute("return 1;", [{ name: "codemode", fns: {} }], {
      signal: controller.signal,
    });
    expect(result.error).toBe("Execution cancelled");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("rejects when the Deno binary cannot be spawned", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);
    const resultPromise = executor.execute("return 1;", [{ name: "codemode", fns: {} }]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.emit("error", Object.assign(new Error("spawn deno ENOENT"), { code: "ENOENT" }));
    await expect(resultPromise).rejects.toThrow(/ENOENT/);
  });
});

describe("deno-bootstrap source", () => {
  function extractExecuteCode(source: string): string {
    const start = source.indexOf("async function executeCode");
    expect(start).toBeGreaterThan(-1);
    // Find the function body's opening brace: the first `{` that is not inside
    // the parameter list or the `Promise<{...}>` return-type annotation.
    let angle = 0;
    let paren = 0;
    let braceStart = -1;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === "<") angle++;
      else if (c === ">") angle--;
      else if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "{" && angle === 0 && paren === 0) {
        braceStart = i;
        break;
      }
    }
    expect(braceStart).toBeGreaterThan(-1);
    let depth = 0;
    let i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(braceStart, i + 1);
    // Rebuild the function with a clean (type-annotation-free) signature so it
    // can be evaluated as plain JavaScript in Node.
    return `async function executeCode(code, timeoutMs) ${body}`;
  }

  test("executeCode returns a guest result (return 42 survives the wrap)", async () => {
    const source = await readFile(new URL("./deno-bootstrap.ts", import.meta.url), "utf-8");
    const extracted = extractExecuteCode(source);
    const js = ts.transpileModule(extracted, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const executeCode = new Function(`${js}\nreturn executeCode;`)() as (
      code: string,
      timeoutMs: number,
    ) => Promise<{ result?: unknown; error?: string; logs: unknown[] }>;

    const ok = await executeCode("return 42;", 5_000);
    expect(ok.error).toBeUndefined();
    expect(ok.result).toBe(42);

    const err = await executeCode("throw new Error('kapow');", 5_000);
    expect(err.error).toContain("kapow");
  });

  test("executeCode clears its execution timer after the code settles", async () => {
    const source = await readFile(new URL("./deno-bootstrap.ts", import.meta.url), "utf-8");
    const extracted = extractExecuteCode(source);
    const js = ts.transpileModule(extracted, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const executeCode = new Function(`${js}\nreturn executeCode;`)() as (
      code: string,
      timeoutMs: number,
    ) => Promise<{ result?: unknown; error?: string; logs: unknown[] }>;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: () => void,
      ms: number,
    ) => {
      const t = setTimeout(cb, ms);
      timers.add(t);
      return t;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      t: ReturnType<typeof setTimeout>,
    ) => {
      timers.delete(t);
      clearTimeout(t);
    }) as typeof clearTimeout);

    try {
      const ok = await executeCode("return 42;", 5_000);
      expect(ok.result).toBe(42);
      expect(timers.size).toBe(0);

      const err = await executeCode("throw new Error('kapow');", 5_000);
      expect(err.error).toContain("kapow");
      expect(timers.size).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test("clears its execution timer in a finally block and exits after done", async () => {
    const source = await readFile(new URL("./deno-bootstrap.ts", import.meta.url), "utf-8");
    // The timer must be cleared so the child does not linger after the code
    // settles (success or failure).
    const finallyBlock = source.match(/finally\s*\{([\s\S]*?)\}/);
    expect(finallyBlock).not.toBeNull();
    expect(finallyBlock![1]).toContain("clearTimeout");
    // The child must exit deterministically after sending the done message.
    expect(source).toContain('send({ type: "done", result });');
    expect(source).toContain("Deno.exit(0)");
  });
});
