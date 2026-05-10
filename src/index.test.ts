/* eslint-disable vitest/require-mock-type-parameters */
import { beforeEach, describe, expect, test, vi } from "vitest";

type TestConfig = {
  mode: "off" | "safe" | "yolo";
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
    name: "execute_tools",
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
    getActiveTools: vi.fn(() => ["read", "write"]),
    getAllTools: vi.fn(() => [
      { name: "read", description: "Read files" },
      { name: "execute_tools", description: "Run codemode" },
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

  test("registers flag, execute_tools, lifecycle handlers, and toggle command", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands } = createPiMock();

    codemodeExtension(pi as never);

    expect(pi.registerFlag).toHaveBeenCalledWith("no-codemode", expect.any(Object));
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "execute_tools" }),
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

  test("session_start defaults to yolo mode with execute_tools and native bash", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(pi.getActiveTools).toHaveBeenCalled();
    expect(pi.setActiveTools).toHaveBeenCalledWith(["execute_tools", "bash"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode yolo mode enabled", "info");
    expect(prompt.systemPrompt).toContain("## Code Mode (yolo)");
    expect(prompt.systemPrompt).toContain("native bash is available");
  });

  test("safe mode activates execute_tools only and prompts accordingly", async () => {
    loadConfig.mockReturnValue({
      mode: "safe",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(pi.setActiveTools).toHaveBeenCalledWith(["execute_tools"]);
    expect(prompt.systemPrompt).toContain("## Code Mode (safe)");
    expect(prompt.systemPrompt).toContain("No native bash tool is exposed");
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
      { name: "execute_tools", description: "Run codemode" },
    ]);
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["execute_tools"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Codemode yolo requested but native bash is unavailable; using safe mode tools",
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

  test("/codemode supports explicit modes and bare off-to-yolo toggle", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands, ctx } = createPiMock();
    codemodeExtension(pi as never);
    await handlers.get("session_start")?.({}, ctx);

    await commands.get("codemode")?.handler(["safe"], ctx);
    await commands.get("codemode")?.handler(["off"], ctx);
    await commands.get("codemode")?.handler([], ctx);

    expect(pi.setActiveTools).toHaveBeenNthCalledWith(1, ["execute_tools", "bash"]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(2, ["execute_tools"]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(3, ["read", "write"]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(4, ["execute_tools", "bash"]);
  });

  test("session_shutdown closes MCP client", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_shutdown")?.();

    expect(shutdown).toHaveBeenCalled();
  });
});
