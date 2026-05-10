import { describe, expect, test } from "vitest";
import { QuickJsExecutor } from "./quickjs-executor.js";

describe("QuickJsExecutor", () => {
  test("returns values and captures print output", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
			print("hello", π.name);
			return { ok: true, name: π.name };
		`,
      [{ name: "codemode", fns: {} }],
      { strings: { name: "quickjs" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ ok: true, name: "quickjs" });
    expect(result.logs).toEqual(["hello quickjs"]);
  });

  test("exposes top-level file tool host calls", async () => {
    const calls: unknown[] = [];
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
			const text = await read({ path: "a.txt" });
			await write({ path: "b.txt", content: text });
			await edit({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
			return codemode.callsDone({});
		`,
      [
        {
          name: "codemode",
          fns: {
            read: async (args: unknown) => {
              calls.push(["read", args]);
              return "contents";
            },
            write: async (args: unknown) => {
              calls.push(["write", args]);
            },
            edit: async (args: unknown) => {
              calls.push(["edit", args]);
              return "edited";
            },
            callsDone: async () => calls,
          },
        },
      ],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([
      ["read", { path: "a.txt" }],
      ["write", { path: "b.txt", content: "contents" }],
      ["edit", { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] }],
    ]);
  });

  test("does not expose file tools through codemode namespace", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(`return typeof codemode.edit;`, [
      { name: "codemode", fns: { edit: async () => "edited" } },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("undefined");
  });

  test("resolves concurrent async host calls", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
			const results = await Promise.all(
				Array.from({ length: 100 }, (_, i) => codemode.echo({ i }))
			);
			return results;
		`,
      [{ name: "codemode", fns: { echo: async (args: unknown) => args } }],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(Array.from({ length: 100 }, (_, i) => ({ i })));
  });

  test("rejects failed host calls", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(`await codemode.fail({});`, [
      {
        name: "codemode",
        fns: {
          fail: async () => {
            throw new Error("boom");
          },
        },
      },
    ]);

    expect(result.error ?? "").toMatch(/boom/);
  });

  test("transforms TypeScript syntax before execution", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
        const value: number = 42;
        const item = { value } satisfies { value: number };
        return item.value;
      `,
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  test("exposes shell globals through host calls", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const calls: unknown[] = [];
    const result = await executor.execute(
      `
        const a = await $` +
        "`echo ${π.name}`" +
        `;
        const b = await shell({ command: "pwd" });
        return { a, b };
      `,
      [
        {
          name: "codemode",
          fns: {
            $: async (args: unknown) => {
              calls.push({ name: "$", args });
              return { stdout: "hello\n", stderr: "", exitCode: 0 };
            },
            shell: async (args: unknown) => {
              calls.push({ name: "shell", args });
              return { stdout: "/workspace\n", stderr: "", exitCode: 0 };
            },
          },
        },
      ],
      { strings: { name: "world" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      a: { stdout: "hello\n", stderr: "", exitCode: 0 },
      b: { stdout: "/workspace\n", stderr: "", exitCode: 0 },
    });
    expect(calls).toEqual([
      { name: "$", args: { parts: ["echo ", ""], values: ["world"] } },
      { name: "shell", args: { command: "pwd" } },
    ]);
  });

  test("captures console output", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
        console.log("hello", { target: "console" });
        console.warn("careful");
      `,
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(['hello {"target":"console"}', "careful"]);
  });

  test("formats runtime errors with message and stack", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `
        function explode() {
          throw new Error("kapow");
        }
        explode();
      `,
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error ?? "").toContain("kapow");
    expect(result.error ?? "").toContain("explode");
  });

  test("exposes nested codemode namespaces", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `return await codemode.github.search_issues({ q: "test" });`,
      [{ name: "codemode", fns: { github: { search_issues: async (args: unknown) => args } } }],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ q: "test" });
  });

  test("does not expose Node globals", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const result = await executor.execute(
      `return { process: typeof process, require: typeof require };`,
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ process: "undefined", require: "undefined" });
  });

  test("releases QuickJS runtime resources after execution", async () => {
    const executor = new QuickJsExecutor({ timeout: 5_000 });

    const result = await executor.execute(`return "disposed cleanly";`, [
      { name: "codemode", fns: {} },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("disposed cleanly");
  });

  test("times out runaway synchronous code", async () => {
    const executor = new QuickJsExecutor({ timeout: 50 });
    const result = await executor.execute(`while (true) {}`, [{ name: "codemode", fns: {} }]);

    expect(result.error).toMatch(/timed out/i);
    expect(result.result).toBeUndefined();
  });

  test("times out a pending async host call and cleans up", async () => {
    const executor = new QuickJsExecutor({ timeout: 50 });
    const result = await executor.execute(`await codemode.never({});`, [
      { name: "codemode", fns: { never: () => new Promise(() => {}) } },
    ]);

    expect(result.error).toBe("Execution timed out after 50ms");
    expect(result.result).toBeUndefined();
  });

  test("does not execute when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    let called = false;

    const result = await executor.execute(
      `await codemode.echo({});`,
      [
        {
          name: "codemode",
          fns: {
            echo: () => {
              called = true;
            },
          },
        },
      ],
      { signal: controller.signal },
    );

    expect(called).toBe(false);
    expect(result.error).toBe("Execution cancelled");
    expect(result.result).toBeUndefined();
  });

  test("cancels a pending async host call and cleans up", async () => {
    const controller = new AbortController();
    const executor = new QuickJsExecutor({ timeout: 5_000 });
    const resultPromise = executor.execute(
      `await codemode.never({});`,
      [{ name: "codemode", fns: { never: () => new Promise(() => {}) } }],
      { signal: controller.signal },
    );

    setImmediate(() => controller.abort());
    const result = await resultPromise;

    expect(result.error).toBe("Execution cancelled");
    expect(result.result).toBeUndefined();
  });
});
