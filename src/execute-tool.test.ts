import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createFileTools } from "./file-tools.js";
import type { ToolBindings } from "./tool-bindings.js";

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
  plan_npm_script: async () => "",
  run_npm_script: async () => "",
  list_mcp_servers: async () => "",
  list_tools: async () => "",
  describe_tools: async () => "",
  cli: {},
  progress: () => undefined,
} satisfies ToolBindings;

describe("createExecuteTool executor selection", () => {
  test("registers the Pi-facing tool as codemode", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    });

    expect(tool.name).toBe("codemode");
    expect(tool.description).toContain("Call this top-level codemode tool");
  });

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

    expect(call.render(80).join("\n")).toContain("codemode");
    expect(call.render(80).join("\n")).toContain("return 1;");
    expect(result.render(80).join("\n")).toContain("ok");
  });

  test("renders long codemode calls compact by default and expanded on demand", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    }) as {
      renderCall: (
        args: { code: string },
        theme: Theme,
        context: { expanded: boolean; isPartial: boolean },
      ) => RenderedComponent;
    };
    const theme = createTheme();
    const code = Array.from({ length: 20 }, (_, i) => `const value${i} = ${i};`).join("\n");

    const collapsed = tool.renderCall({ code }, theme, { expanded: false, isPartial: false });
    const expanded = tool.renderCall({ code }, theme, { expanded: true, isPartial: false });

    expect(collapsed.render(80).join("\n")).toContain("20 lines");
    expect(collapsed.render(80).join("\n")).not.toContain("value10");
    expect(collapsed.render(80).join("\n")).toContain("value0");
    expect(collapsed.render(80).join("\n")).toContain("value18");
    expect(expanded.render(80).join("\n")).toContain("value19");
  });

  test("pretty-prints single-line codemode calls before rendering", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    }) as {
      renderCall: (
        args: { code: string },
        theme: Theme,
        context: { expanded: boolean; isPartial: boolean },
      ) => RenderedComponent;
    };
    const theme = createTheme();
    const code = "const first = 1; const second = 2; return first + second;";

    const rendered = tool.renderCall({ code }, theme, { expanded: true, isPartial: false });
    const text = rendered.render(80).join("\n");

    expect(text).toContain("3 lines");
    expect(text).toContain("const first = 1;\nconst second = 2;\nreturn first + second;");
  });

  test("renders long codemode results compact by default with expand hint", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    }) as {
      renderResult: (
        result: unknown,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: unknown,
      ) => RenderedComponent;
    };
    const theme = createTheme();
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");

    const collapsed = tool.renderResult(
      { content: [{ type: "text", text }] },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const expanded = tool.renderResult(
      { content: [{ type: "text", text }] },
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(collapsed.render(80).join("\n")).toContain("Ctrl+O to expand");
    expect(collapsed.render(80).join("\n")).toContain("line 0");
    expect(collapsed.render(80).join("\n")).not.toContain("line 6");
    expect(collapsed.render(80).join("\n")).toContain("line 11");
    expect(expanded.render(80).join("\n")).toContain("line 11");
  });

  test("renders multi-error codemode failures compact by default with expand hint", () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    }) as {
      renderResult: (
        result: unknown,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: unknown,
      ) => RenderedComponent;
    };
    const theme = createTheme();
    const result = {
      isError: true,
      content: [{ type: "text", text: "error one\nerror two" }],
      details: {
        errors: [
          { line: 1, column: 1, message: "first error" },
          { line: 2, column: 1, message: "second error" },
        ],
      },
    };

    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {});

    expect(collapsed.render(80).join("\n")).toContain("first error");
    expect(collapsed.render(80).join("\n")).toContain("Ctrl+O to expand");
    expect(collapsed.render(80).join("\n")).not.toContain("second error");
    expect(expanded.render(80).join("\n")).toContain("Line 2: second error");
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

  test("supports top-level text result formatting for command-like return values", async () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    });

    const result = await tool.execute(
      "call-id",
      {
        code: 'return { stdout: "\\u001b[32mok\\u001b[0m\\n", stderr: "", exitCode: 0 };',
        resultFormat: "text",
      },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe("ok\n");
  });

  test("supports top-level raw result formatting", async () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "quickjs" },
    });

    const result = await tool.execute(
      "call-id",
      {
        code: 'return { stdout: "\\u001b[32mok\\u001b[0m\\n", stderr: "", exitCode: 0 };',
        resultFormat: "raw",
      },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(result.content[0].text).toBe("\u001b[32mok\u001b[0m\n");
  });
});

describe("codemode integration", () => {
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
});
