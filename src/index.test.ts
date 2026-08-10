/* eslint-disable vitest/require-mock-type-parameters */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TestConfig = {
  mode: "off" | "on" | "yolo";
  executor: { type: "quickjs"; timeoutMs: number };
};

const { loadConfig, createMcpClient, shutdown, warmCache, getServers } = vi.hoisted(() => {
  const shutdown = vi.fn(async () => {});
  const warmCache = vi.fn(async () => []);
  const getServers = vi.fn(() => []);
  return {
    loadConfig: vi.fn<() => TestConfig>(() => ({
      mode: "yolo",
      executor: { type: "quickjs", timeoutMs: 1234 },
    })),
    createMcpClient: vi.fn(() => ({ getServers, warmCache, shutdown })),
    shutdown,
    warmCache,
    getServers,
  };
});

vi.mock("./config.js", () => ({ loadConfig }));
vi.mock("./mcp-client.js", () => ({ createMcpClient }));
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
    getActiveTools: vi.fn(() => ["read", "write", "bash"]),
    getAllTools: vi.fn(() => [
      { name: "read", description: "Read files" },
      { name: "write", description: "Write files" },
      { name: "edit", description: "Edit files" },
      { name: "bash", description: "Run shell commands" },
      { name: "codemode", description: "Run codemode" },
    ]),
    setActiveTools: vi.fn((tools: string[]) => activeTools.push(tools)),
  };
  const ctx = { ui: { notify: vi.fn() } };
  return { pi, handlers, commands, activeTools, ctx };
}

describe("codemodeExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      mode: "yolo",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    createMcpClient.mockReset();
    createMcpClient.mockImplementation(() => ({ getServers, warmCache, shutdown }));
    getServers.mockReturnValue([]);
    warmCache.mockResolvedValue([]);
  });

  test("registers flag, codemode tool, lifecycle handlers, and toggle command", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands } = createPiMock();

    codemodeExtension(pi as never);

    expect(pi.registerFlag).toHaveBeenCalledWith("no-codemode", expect.any(Object));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "codemode" }));
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "session_shutdown",
      "before_agent_start",
    ]);
    expect(commands.has("codemode")).toBe(true);
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
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode yolo mode enabled", "info");
    expect(prompt.systemPrompt).toContain("## Code Mode (yolo)");
    expect(prompt.systemPrompt).toContain("native bash is available");
  });

  test("does not leak internal issue numbers into system prompts", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);
    const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as {
      systemPrompt: string;
    };

    expect(prompt.systemPrompt).not.toMatch(/#\d+/);
    expect(prompt.systemPrompt).toContain("top-level visible patch editing");
  });

  test("surfaces startup config and MCP failures via UI notify on session_start", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("bad config for test");
    });
    createMcpClient.mockImplementation(() => {
      throw new Error("mcp boom");
    });

    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("config load failed"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP init failed"),
      "warning",
    );
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
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
    expect(prompt.systemPrompt).toContain("## Code Mode (on)");
    expect(prompt.systemPrompt).toContain("native bash tool is not exposed");
    expect(prompt.systemPrompt).toContain("Writes are restricted to the project root");
    expect(prompt.systemPrompt).toContain(
      "If the result you need is primarily stdout/stderr from one or more CLI calls, return a plain string",
    );
    expect(prompt.systemPrompt).toContain(
      "Prefer `text` for your own reasoning because some transcript/log surfaces show raw ANSI escapes literally",
    );
    expect(prompt.systemPrompt).toContain(
      "Write human-readable, nicely formatted TypeScript with normal line breaks",
    );
    expect(prompt.systemPrompt).toContain("Ctrl+O");
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

    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "replace_in_file" }),
    );
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "apply_patch" }));
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
  });

  test("on mode is write-locked — native write/edit/bash are not active", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    // Pi's base set includes all native write-capable tools.
    pi.getActiveTools.mockReturnValue(["read", "write", "edit", "bash"]);
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    const active = pi.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(active).toContain("read");
    expect(active).toContain("replace_in_file");
    expect(active).toContain("apply_patch");
    expect(active).toContain("codemode");
    expect(active).not.toContain("write");
    expect(active).not.toContain("edit");
    expect(active).not.toContain("bash");
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
      { expanded: true, isPartial: false },
    );
    const result = applyPatch.renderResult(
      {
        content: [
          {
            type: "text",
            text: "Applied patch to 1 file\n--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
          },
        ],
      },
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

  test("file edit tools are compact by default and expanded on demand", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi } = createPiMock();
    codemodeExtension(pi as never);
    const applyPatch = pi.registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "apply_patch");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      success: (text: string) => text,
      error: (text: string) => text,
    };
    const patch = "--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n";

    const collapsedCall = applyPatch.renderCall({ patch }, theme, {
      expanded: false,
      isPartial: false,
    });
    const expandedCall = applyPatch.renderCall({ patch }, theme, {
      expanded: true,
      isPartial: false,
    });
    const collapsedResult = applyPatch.renderResult(
      { content: [{ type: "text", text: `Applied patch to 1 file\n${patch}` }] },
      { expanded: false, isPartial: false },
      theme,
      {},
    );

    expect(collapsedCall.render(80).join("\n")).toContain("--- a/test.txt");
    expect(collapsedCall.render(80).join("\n")).toContain("-old");
    expect(expandedCall.render(80).join("\n")).toContain("-old");
    expect(collapsedResult.render(80).join("\n")).toContain("--- a/test.txt");
    expect(collapsedResult.render(80).join("\n")).toContain("-old");
  });

  test("replace_in_file results are compact by default and expanded on demand", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi } = createPiMock();
    codemodeExtension(pi as never);
    const replaceInFile = pi.registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "replace_in_file");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      success: (text: string) => text,
      error: (text: string) => text,
    };
    const middle = Array.from({ length: 30 }, (_, i) => ` line ${i}`).join("\n");
    const text = `Updated test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n${middle}\n-tail`;

    const collapsed = replaceInFile.renderResult(
      { content: [{ type: "text", text }] },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const expanded = replaceInFile.renderResult(
      { content: [{ type: "text", text }] },
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    expect(collapsed.render(80).join("\n")).toContain("Ctrl+O to expand");
    expect(collapsed.render(80).join("\n")).not.toContain("line 15");
    expect(expanded.render(80).join("\n")).toContain("line 15");
    expect(expanded.render(80).join("\n")).toContain("Ctrl+O to collapse");
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

  test("off mode deactivates codemode tools if Pi includes newly registered tools as active", async () => {
    loadConfig.mockReturnValue({
      mode: "off",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, ctx } = createPiMock();
    pi.getActiveTools.mockReturnValue([
      "read",
      "write",
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
    codemodeExtension(pi as never);

    await handlers.get("session_start")?.({}, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "write", "bash"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode off — normal Pi tools active", "info");
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

    // Pi passes the raw argument string after the command name, not string[].
    await commands.get("codemode")?.handler("on", ctx);
    await commands.get("codemode")?.handler("off", ctx);
    await commands.get("codemode")?.handler("", ctx);

    expect(pi.setActiveTools).toHaveBeenNthCalledWith(1, [
      "read",
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(2, [
      "read",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining(["read", "write", "bash"]),
    );
    expect(pi.setActiveTools.mock.calls[2]?.[0]).not.toContain("codemode");
    expect(pi.setActiveTools).toHaveBeenNthCalledWith(4, [
      "read",
      "replace_in_file",
      "apply_patch",
      "codemode",
    ]);
  });

  test("restores native bash when leaving codemode even if session snapshot omitted it", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands, ctx } = createPiMock();
    // Simulate Pi sessions where getActiveTools() at start lacks bash (filtered/partial),
    // but bash remains a registered host tool.
    pi.getActiveTools.mockReturnValue(["read", "write"]);
    pi.getAllTools.mockReturnValue([
      { name: "read", description: "Read files" },
      { name: "write", description: "Write files" },
      { name: "edit", description: "Edit files" },
      { name: "bash", description: "Run shell commands" },
      { name: "codemode", description: "Run codemode" },
    ]);
    codemodeExtension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    pi.setActiveTools.mockClear();

    await commands.get("codemode")?.handler("yolo", ctx);
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining(["bash", "codemode"]),
    );

    await commands.get("codemode")?.handler("off", ctx);
    const offTools = pi.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(offTools).toEqual(expect.arrayContaining(["read", "write", "bash", "edit"]));
    expect(offTools).not.toEqual(expect.arrayContaining(["codemode"]));
    expect(offTools).not.toContain("replace_in_file");
    expect(offTools).not.toContain("apply_patch");
  });

  test("off mode always reapplies native tools after on (never leaves codemode set stuck)", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands, ctx } = createPiMock();
    // Only codemode-owned names in the active snapshot — previous bug skipped setActiveTools.
    pi.getActiveTools.mockReturnValue(["codemode", "replace_in_file", "apply_patch"]);
    pi.getAllTools.mockReturnValue([
      { name: "read", description: "Read" },
      { name: "write", description: "Write" },
      { name: "bash", description: "Bash" },
      { name: "codemode", description: "Codemode" },
    ]);
    codemodeExtension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    pi.setActiveTools.mockClear();

    await commands.get("codemode")?.handler("off", ctx);
    expect(pi.setActiveTools).toHaveBeenCalled();
    const offTools = pi.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(offTools).toEqual(expect.arrayContaining(["read", "write", "bash"]));
    expect(offTools).not.toContain("codemode");
  });

  test("/codemode yolo enables yolo mode from Pi's string args", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers, commands, ctx } = createPiMock();
    codemodeExtension(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    ctx.ui.notify.mockClear();
    pi.setActiveTools.mockClear();

    await commands.get("codemode")?.handler("yolo", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Codemode yolo mode enabled", "info");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Usage: /codemode [on|yolo|off]", "warning");
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "replace_in_file",
      "apply_patch",
      "codemode",
      "bash",
    ]);
  });

  test("yolo mode patch tools execute on absolute paths outside project root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "codemode-index-yolo-"));
    try {
      const outsidePath = join(outsideDir, "scratch.txt");
      writeFileSync(outsidePath, "hello outside");

      const { default: codemodeExtension } = await import("./index.js");
      const { pi, handlers, ctx } = createPiMock();
      codemodeExtension(pi as never);
      await handlers.get("session_start")?.({}, ctx);

      const tools = pi.registerTool.mock.calls.map((call) => call[0]);
      const replaceInFile = tools.find((tool) => tool.name === "replace_in_file");
      const applyPatch = tools.find((tool) => tool.name === "apply_patch");
      expect(replaceInFile).toBeDefined();
      expect(applyPatch).toBeDefined();

      const replaceResult = await replaceInFile.execute("call-1", {
        path: outsidePath,
        edits: [{ oldText: "outside", newText: "yolo" }],
      });
      expect(replaceResult.content[0].text).toContain("Replaced 1 occurrence");
      expect(readFileSync(outsidePath, "utf-8")).toBe("hello yolo");

      writeFileSync(outsidePath, "line1\nline2\nline3\n");
      const patchResult = await applyPatch.execute("call-2", {
        patch: `--- a/${outsidePath}
+++ b/${outsidePath}
@@ -1,3 +1,3 @@
 line1
-line2
+changed
 line3
`,
      });
      expect(patchResult.content[0].text).toContain("Applied patch to 1 file");
      expect(readFileSync(outsidePath, "utf-8")).toBe("line1\nchanged\nline3\n");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("on mode patch tools reject absolute paths outside project root", async () => {
    loadConfig.mockReturnValue({
      mode: "on",
      executor: { type: "quickjs", timeoutMs: 1234 },
    });
    const outsideDir = mkdtempSync(join(tmpdir(), "codemode-index-on-"));
    try {
      const outsidePath = join(outsideDir, "scratch.txt");
      writeFileSync(outsidePath, "hello outside");

      const { default: codemodeExtension } = await import("./index.js");
      const { pi, handlers, ctx } = createPiMock();
      codemodeExtension(pi as never);
      await handlers.get("session_start")?.({}, ctx);

      const tools = pi.registerTool.mock.calls.map((call) => call[0]);
      const replaceInFile = tools.find((tool) => tool.name === "replace_in_file");
      const applyPatch = tools.find((tool) => tool.name === "apply_patch");
      expect(replaceInFile).toBeDefined();
      expect(applyPatch).toBeDefined();

      await expect(
        replaceInFile.execute("call-1", {
          path: outsidePath,
          edits: [{ oldText: "outside", newText: "blocked" }],
        }),
      ).rejects.toThrow("Path outside project");

      await expect(
        applyPatch.execute("call-2", {
          patch: `--- a/${outsidePath}
+++ b/${outsidePath}
@@ -1 +1 @@
-hello outside
+blocked
`,
        }),
      ).rejects.toThrow("Path outside project");

      expect(readFileSync(outsidePath, "utf-8")).toBe("hello outside");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("session_shutdown closes MCP client", async () => {
    const { default: codemodeExtension } = await import("./index.js");
    const { pi, handlers } = createPiMock();
    codemodeExtension(pi as never);

    await handlers.get("session_shutdown")?.();

    expect(shutdown).toHaveBeenCalled();
  });
});
