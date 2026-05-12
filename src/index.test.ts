/* eslint-disable vitest/require-mock-type-parameters */
import { beforeEach, describe, expect, test, vi } from "vitest";

type TestConfig = {
  mode: "off" | "on" | "yolo";
  executor: { type: "quickjs"; timeoutMs: number };
};

const loadConfig = vi.fn<() => TestConfig>(() => ({
  mode: "yolo",
  executor: { type: "quickjs", timeoutMs: 1234 },
}));
const shutdown = vi.fn(async () => {});
const warmCache = vi.fn(async () => []);
const getServers = vi.fn(() => []);
const initShell = vi.fn(async () => {});

vi.mock("./config.js", () => ({ loadConfig }));
vi.mock("./mcp-client.js", () => ({
  createMcpClient: vi.fn(() => ({ getServers, warmCache, shutdown })),
}));
vi.mock("./shell.js", () => ({
  generateShellTypeDefs: vi.fn(() => ""),
  initShell,
}));
vi.mock("./execute-tool.js", () => ({
  createExecuteTool: vi.fn(() => ({
    name: "codemode",
    description: "Execute TypeScript against codemode tools",
  })),
}));
vi.mock("./type-generator.js", () => ({
  generateBuiltinTypeDefs: vi.fn(() => "declare const codemode: {};"),
  generateMcpServerTypeDefs: vi.fn(() => ""),
  generateMcpSummaryForPrompt: vi.fn(() => ""),
  generateParamSummary: vi.fn(() => "summary"),
}));

type Handler = (...args: unknown[]) => unknown;

function createPiMock() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const activeTools: string[][] = [];
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerCommand: vi.fn((name: string, command: { handler: Handler }) =>
      commands.set(name, command),
    ),
    getActiveTools: vi.fn(() => ["read", "write", "replace_in_file", "apply_patch", "bash"]),
    getAllTools: vi.fn(() => [
      { name: "read", description: "Read files" },
      { name: "codemode", description: "Run codemode" },
      { name: "bash", description: "Run shell commands" },
    ]),
    setActiveTools: vi.fn((tools: string[]) => activeTools.push(tools)),
  };
  const ctx = { ui: { notify: vi.fn() } };
  return { pi, handlers, commands, activeTools, ctx };
}

describe("codemodeExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({
      mode: "yolo",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    getServers.mockReturnValue([]);
  });

  test("registers flag, codemode tool, lifecycle handlers, and toggle command", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands } = createPiMock();

    codemodeExtension(pi as never);

    expect(pi.registerFlag).toHaveBeenCalledWith("no-codemode", expect.any(Object));
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "codemode" }),
    );
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_shutdown",
      "before_agent_start",
    ]);
    expect(commands.has("codemode")).toBe(true);
  });

  test("initializes just-bash for the current project", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi } = createPiMock();

    codemodeExtension(pi as never);

    expect(initShell).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: process.cwd() }));
  });

  test("session_start defaults to yolo mode with codemode and native bash", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(pi.getActiveTools).toHaveBeenCalled();
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode yolo mode enabled", "info");
    expect(prompt.systemPrompt).toContain("## Code Mode (yolo)");
    expect(prompt.systemPrompt).toContain("native bash is available");
  });

  test("on mode activates codemode plus non-bash tools and prompts accordingly", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
    expect(prompt.systemPrompt).toContain("## Code Mode (on)");
    expect(prompt.systemPrompt).toContain("native bash tool is not exposed");
    expect(prompt.systemPrompt).toContain(
      'If the result you need is primarily stdout/stderr from one or more CLI calls, return a plain string',
    );
    expect(prompt.systemPrompt).toContain(
      "Prefer `text` for your own reasoning because some transcript/log surfaces show raw ANSI escapes literally",
    );
  });

  test("on mode replaces native edit with codemode file edit tools", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    pi.getActiveTools.mockReturnValue(["read", "write", "edit", "bash"]);
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "replace_in_file" }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "apply_patch" }));
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
  });

  test("file edit tools render visible diffs in calls and results", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi } = createPiMock();
    codemodeExtension(pi as never);
    const applyPatch = pi.registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "apply_patch");
    const colors: string[] = [];
    const theme = {
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
      bold: (text: string) => text,
      success: (text: string) => text,
      error: (text: string) => text,
    };

    const call = applyPatch.renderCall(
      { patch: "--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
      theme,
      {},
    );
    const result = applyPatch.renderResult(
      { content: [{ type: "text", text: "Applied patch to 1 file\n--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n-old\n+new" }] },
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(call.render(80).join("\n")).toContain("--- a/test.txt");
    expect(result.render(80).join("\n")).toContain("-old");
    expect(result.render(80).join("\n")).toContain("+new");
    expect(colors).toContain("toolDiffRemoved");
    expect(colors).toContain("toolDiffAdded");
    expect(colors).toContain("toolDiffContext");
  });

  test("off mode leaves native tools active and prompt guidance native", async () => {
    loadConfig.mockReturnValue({
      mode: "off",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode off — normal Pi tools active", "info");
    expect(prompt.systemPrompt).toContain("## Native Tool Guidance");
  });

  test("yolo mode degrades when native bash is unavailable", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    pi.getAllTools.mockReturnValue([
      { name: "read", description: "Read files" },
      { name: "codemode", description: "Run codemode" },
    ]);
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Codemode yolo requested but native bash is unavailable; using normal codemode tools",
      "warning",
    );
  });

  test("no-codemode flag starts in off mode", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    pi.getFlag.mockImplementation((name?: string) => name === "no-codemode");
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode off — normal Pi tools active", "info");
  });

  test("/codemode supports explicit modes and bare off-to-on toggle", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands, ctx } = createPiMock();
    codemodeExtension(pi as never);
    await handlers.get("session_start")?.({}, ctx);

    await commands.get("codemode")?.handler(["on"], ctx);
    await commands.get("codemode")?.handler(["off"], ctx);
    await commands.get("codemode")?.handler([], ctx);

    expect(pi.setActiveTools).toHaveBeenNthCalledWith(1, [
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(2, [
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(3, [
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "bash",
    ]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(4, [
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
  });

  test("session_shutdown closes MCP client", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_shutdown")?.();

    expect(shutdown).toHaveBeenCalled();
  });
});
