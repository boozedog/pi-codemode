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

vi.mock("@mariozechner/pi-tui", () => ({
  Text: class Text {
    constructor(public text: string) {}
    setText(text: string) {
      this.text = text;
    }
    render() {
      return [this.text];
    }
  },
}));

const { createExecuteTool } = await import("./execute-tool.js");

interface RenderedComponent {
  render(width: number): string[];
}

interface Theme {
  fg(color: string, text: string): string;
  error(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  bold(text: string): string;
}

function createTheme(): Theme {
  return {
    fg: (_color, text) => text,
    error: (text) => text,
    success: (text) => text,
    warning: (text) => text,
    bold: (text) => text,
  };
}

const bindings = {
  read: async () => "",
  write: async () => undefined,
  replace_in_file: async () => "",
  apply_patch: async () => "",
  search_tools: async () => "",
  list_mcp_servers: async () => "",
  list_tools: async () => "",
  describe_tools: async () => "",
  cli: {},
  progress: () => undefined,
} satisfies ToolBindings;

describe("createExecuteTool executor selection", () => {
  test("renders tool call and result as TUI components", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    }) as {
      renderCall: (args: { code: string }, theme: Theme, context: unknown) => RenderedComponent;
      renderResult: (
        result: unknown,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: unknown,
      ) => RenderedComponent;
    };
    const theme = createTheme();

    const call = tool.renderCall({ code: "return 1;" }, theme, {});
    const result = tool.renderResult(
      { content: [{ type: "text", text: "ok" }], details: { elapsedMs: 12 } },
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(call.render(80).join("\n")).toContain("return 1;");
    expect(result.render(80).join("\n")).toContain("ok");
  });

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

  test("executes QuickJS code against real replace_in_file and read bindings", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "edit-me.txt"), "hello world");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function read(params: { path: string }): Promise<string>;
          declare function replace_in_file(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
          replace_in_file: async (params) => fileTools.replace_in_file(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            await replace_in_file({
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
          declare function replace_in_file(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
          write: async (params) => fileTools.write(params),
          replace_in_file: async (params) => fileTools.replace_in_file(params),
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
            await replace_in_file({
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

  test("returns runtime error when real replace_in_file binding rejects", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "edit-me.txt"), "hello world");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: `
          declare function replace_in_file(params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
          }): Promise<string>;
        `,
        bindings: {
          ...bindings,
          replace_in_file: async (params) => fileTools.replace_in_file(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        {
          code: `
            await replace_in_file({
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
