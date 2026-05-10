import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createFileTools } from "./file-tools.js";
import type { ToolBindings } from "./tool-bindings.js";

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: () => ({ type: "string" }),
    Optional: (schema: unknown) => schema,
    Record: () => ({ type: "object" }),
  },
}));

const { createExecuteTool } = await import("./execute-tool.js");

const bindings = {
  read: async () => "",
  write: async () => undefined,
  edit: async () => "",
  search_tools: async () => "",
  describe_tools: async () => "",
  $: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  shell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  progress: () => undefined,
} satisfies ToolBindings;

describe("createExecuteTool executor selection", () => {
  test("uses the configured executor", async () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "deno", deno: { denoPath: "definitely-not-a-deno-binary" } },
    });

    const result = await tool.execute(
      "call-id",
      { code: "return 1;" },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Configured executor 'deno' is unavailable");
  });
});

describe("execute_tools integration", () => {
  test("executes QuickJS code against real file read binding", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "hello.txt"), "hello from file");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: "declare function read(params: { path: string }): Promise<string>;",
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        { code: 'return await read({ path: "hello.txt" });' },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("hello from file");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("executes QuickJS code against real file write and read bindings", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function read(params: { path: string }): Promise<string>;
          declare function write(params: { path: string; content: string }): Promise<void>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
          write: async (params) => fileTools.write(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            await write({ path: "created.txt", content: "created from QuickJS" });
            return await read({ path: "created.txt" });
          `,
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("created from QuickJS");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("executes QuickJS code against real file edit and read bindings", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "edit-me.txt"), "hello world");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function read(params: { path: string }): Promise<string>;
          declare function edit(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
          edit: async (params) => fileTools.edit(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            await edit({
              path: "edit-me.txt",
              edits: [{ oldText: "world", newText: "codemode" }],
            });
            return await read({ path: "edit-me.txt" });
          `,
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("hello codemode");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("writes and edits hard-to-quote content from π strings end-to-end", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare const π: { original: string; replacement: string };
          declare function read(params: { path: string }): Promise<string>;
          declare function write(params: { path: string; content: string }): Promise<void>;
          declare function edit(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
          write: async (params) => fileTools.write(params),
          edit: async (params) => fileTools.edit(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const original = "line 1\nquotes: \"double\" and 'single'\ntemplate: ${notJs}\nbacktick: `\n";
      const replacement = 'updated\njson-ish: {"ok": true}\nslashes: C:\\tmp\\file\n';
      const result = await tool.execute(
        "call-id",
        {
          code: `
            await write({ path: "hard-to-quote.txt", content: π.original });
            await edit({
              path: "hard-to-quote.txt",
              edits: [{ oldText: π.original, newText: π.replacement }],
            });
            return await read({ path: "hard-to-quote.txt" });
          `,
          strings: { original, replacement },
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe(replacement);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("resolves concurrent real file reads through Promise.all", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "a.txt"), "alpha");
      writeFileSync(join(projectDir, "b.txt"), "bravo");
      writeFileSync(join(projectDir, "c.txt"), "charlie");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: "declare function read(params: { path: string }): Promise<string>;",
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            return await Promise.all([
              read({ path: "a.txt" }),
              read({ path: "b.txt" }),
              read({ path: "c.txt" }),
            ]);
          `,
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe('[\n  "alpha",\n  "bravo",\n  "charlie"\n]');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("returns runtime error for path traversal through real file binding", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: "declare function read(params: { path: string }): Promise<string>;",
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        { code: 'return await read({ path: "../outside.txt" });' },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Runtime error:");
      expect(result.content[0].text).toContain("Path outside project: ../outside.txt");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("formats print logs and file-tool return values", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "log-value.txt"), "from file");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function print(...args: unknown[]): void;
          declare function read(params: { path: string }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            print("before read");
            const content = await read({ path: "log-value.txt" });
            print("after read", content.length);
            return { content };
          `,
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe(
        'before read\nafter read 9\n\n{\n  "content": "from file"\n}',
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("returns runtime error when real file edit binding rejects", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "edit-me.txt"), "hello world");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function edit(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          edit: async (params) => fileTools.edit(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            await edit({
              path: "edit-me.txt",
              edits: [{ oldText: "missing", newText: "codemode" }],
            });
          `,
        },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("oldText not found");
      expect(result.content[0].text).toContain("missing");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
