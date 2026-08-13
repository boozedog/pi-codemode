// index.ts — Pi Codemode extension entry point.
//
// Replaces Pi's tools with a single codemode tool that runs
// TypeScript code against typed tool APIs.
//
// This is a new implementation based on Cloudflare Codemode patterns,
// adapted for Pi's native tool system with QuickJS sandboxing.

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { initTypeChecker } from "./type-checker.js";
import { buildSearchIndex, type McpServerInfo } from "./search.js";
import {
  generateBuiltinTypeDefs,
  generateMcpServerTypeDefs,
  generateMcpSummaryForPrompt,
  generateParamSummary,
} from "./type-generator.js";
import { createExecuteTool } from "./execute-tool.js";
import { createMcpClient, type McpClient } from "./mcp-client.js";
import { createToolBindings } from "./tool-bindings.js";
import { loadConfig, type CodemodeConfig, type CodemodeMode } from "./config.js";
import { createFileTools, type FileScope } from "./file-tools.js";
import { generateNativeEditGuidance, generateSystemPromptAddition } from "./system-prompt.js";
import type { SendMessageFn, SendMessageParams } from "./tool-bindings.js";
import { executeCode } from "./execute-tool.js";
import {
  parseRunInvocation,
  readJobEntry,
  resolveJobEntry,
  resolveJobPackage,
  renderHandoffPrompt,
  serializeJobResult,
  writeJobStdout,
} from "./runner.js";

const CODEMODE_MESSAGE_TYPE = "codemode";

export default function codemodeExtension(pi: ExtensionAPI) {
  // --- Configuration ---

  pi.registerFlag("codemode", {
    description: "Enable code mode (default: normal tools)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("no-codemode", {
    description: "Deprecated no-op: codemode is disabled by default",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("run", {
    description: "Run a codemode skill or TypeScript entry without a model turn",
    type: "string",
  });

  // --- State ---

  let currentMode: CodemodeMode = "off";
  let originalTools: string[] = [];
  let mcpClient: McpClient | undefined;
  let mcpServers: McpServerInfo[] = [];
  let handoffStarted = false;
  /** Latest session context, used by the debounced MCP list_changed refresh. */
  let activeCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping refreshSession() calls. */
  let refreshing = false;
  /** Startup problems to surface via UI once session_start provides a context. */
  const startupWarnings: string[] = [];

  // Initialize the TypeScript type checker (pre-loads lib files, ~50ms)
  initTypeChecker();

  // --- Load configuration ---
  let config: CodemodeConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `Codemode: config load failed: ${message}`;
    console.warn(warning);
    startupWarnings.push(warning);
    config = { mode: "on", executor: { type: "quickjs", timeoutMs: 120_000 } };
  }

  // --- Load MCP server info ---
  try {
    mcpClient = createMcpClient({
      config,
      enrichError: generateParamSummary,
      onToolsListChanged: scheduleToolsRefresh,
    });
    mcpServers = mcpClient.getServers();
    void mcpClient
      .warmCache()
      .then((servers) => {
        mcpServers = servers;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const warning = `Codemode: MCP cache warmup failed: ${message}`;
        console.warn(warning);
        startupWarnings.push(warning);
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `Codemode: MCP init failed: ${message}`;
    console.warn(warning);
    startupWarnings.push(warning);
    mcpServers = [];
  }

  // --- Build type definitions ---
  let builtinTypeDefs = generateBuiltinTypeDefs({ cli: config.cli });
  let mcpTypeDefs = generateMcpServerTypeDefs(mcpServers);
  let typeCheckerTypeDefs = builtinTypeDefs + "\n" + mcpTypeDefs;
  let mcpSummary = generateMcpSummaryForPrompt(mcpServers);

  // --- Create tool bindings factory ---
  function getBindings(
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (update: {
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }) => void,
    mode?: string,
    enableCreateFile?: boolean,
  ) {
    return createToolBindings({
      cwd,
      mcpServers,
      mcpClient,
      cli: config.cli,
      signal,
      onUpdate,
      sendMessage: makeSendMessageSink(mode),
      enableCreateFile,
    });
  }

  /**
   * Route guest sendMessage output without putting default chatter in model context.
   */
  function makeSendMessageSink(mode: string | undefined): SendMessageFn {
    return createSendMessageSink(pi, mode);
  }

  // Render codemode.sendMessage output in the TUI without LLM context.
  pi.registerEntryRenderer(CODEMODE_MESSAGE_TYPE, (entry, options, theme) => {
    const content = (entry as { data?: { content?: string } }).data?.content ?? "";
    return new Text(theme.fg("accent", content), options.outputPad ?? 0, 0);
  });

  // --- Shared file scope (mutable unrestricted flag flipped in applyMode) ---
  const fileScope: FileScope = { root: process.cwd(), unrestricted: false };

  // --- Register codemode tools ---

  for (const tool of createTopLevelFileTools(fileScope)) {
    pi.registerTool(tool);
  }

  const executeTool = createExecuteTool({
    typeDefs: typeCheckerTypeDefs,
    getTypeDefs: () => typeCheckerTypeDefs,
    getBindings: ({ signal, onUpdate, cwd, mode }) =>
      getBindings(cwd ?? process.cwd(), signal, onUpdate, mode),
    timeout: config.executor?.timeoutMs ?? 120_000,
    executor: { kind: config.executor?.type ?? "quickjs" },
  });

  pi.registerTool(executeTool);

  // --- Session lifecycle ---

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    activeCtx = ctx;
    const requestedJob = pi.getFlag("run");
    if (typeof requestedJob === "string" && requestedJob.trim()) {
      const code = await runJob(requestedJob.trim(), ctx);
      // Pi's print loop has no model turn to finish the process after an extension flag.
      if (ctx.mode === "print" && (code !== 0 || !handoffStarted)) process.exit(code);
      return;
    }
    // Store baseline native tool set for toggling back to "off".
    // Strip codemode-owned names in case Pi already activated newly registered tools.
    const owned = new Set(codemodeOwnedTools());
    originalTools = pi.getActiveTools().filter((tool) => !owned.has(tool));

    // Build search index over all Pi tools
    const piTools = pi.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    buildSearchIndex(piTools, mcpServers, config.cli);

    // Flush any startup warnings once UI is available (config/MCP failures, etc.)
    while (startupWarnings.length > 0) {
      const warning = startupWarnings.shift();
      if (warning) ctx.ui.notify(warning, "warning");
    }

    const startMode: CodemodeMode = pi.getFlag("no-codemode") ? "off" : config.mode;
    applyMode(startMode, ctx);
  });

  // --- Shutdown ---

  pi.on("session_shutdown", async () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (mcpClient) {
      await mcpClient.shutdown();
    }
  });

  // --- System prompt injection ---

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    const addition =
      currentMode !== "off"
        ? generateSystemPromptAddition(builtinTypeDefs, mcpSummary, currentMode)
        : generateNativeEditGuidance();

    return {
      systemPrompt: event.systemPrompt + "\n\n" + addition,
    };
  });

  // --- Toggle command ---

  pi.registerCommand("codemode", {
    description:
      "Set code mode: on, yolo, off (bare toggles off <-> on); refresh reloads config and MCP tools",
    handler: async (args: string, ctx: ExtensionContext) => {
      // Pi passes the raw text after `/codemode` as one string, e.g. "yolo".
      const requested = args.trim().split(/\s+/).find(Boolean);
      if (requested === "refresh" || requested === "reload") {
        await refreshSession(ctx);
        return;
      }
      const mode = requested as CodemodeMode | undefined;
      if (mode && !["off", "on", "yolo"].includes(mode)) {
        ctx.ui.notify("Usage: /codemode [on|yolo|off|refresh]", "warning");
        return;
      }
      applyMode(mode ?? (currentMode === "off" ? "on" : "off"), ctx);
    },
  });

  pi.registerCommand("run", {
    description: "Run a codemode skill or TypeScript entry, optionally handing off to the model",
    handler: async (args: string, ctx: ExtensionContext) => {
      const input = args.trim();
      if (!input) {
        process.stderr.write("Usage: /run <skill-name-or-path> [key=value|--key[=value]]\n");
        process.exitCode = 2;
        return;
      }
      const code = await runJob(input, ctx);
      if (code !== 0) process.exitCode = code;
    },
  });

  // --- Helpers ---

  /**
   * Debounce MCP `notifications/tools/list_changed` into a single tool re-list.
   */
  function scheduleToolsRefresh(serverName: string) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (activeCtx) void refreshToolsForServer(serverName, activeCtx);
    }, 500);
  }

  /**
   * Re-list tools for a still-connected server and regenerate declarations.
   */
  async function refreshToolsForServer(serverName: string, ctx: ExtensionContext): Promise<void> {
    if (!mcpClient) return;
    try {
      mcpServers = await mcpClient.refreshServerTools(serverName);
      regenerateDeclarations();
      ctx.ui.notify(`Codemode refreshed tools for ${serverName}`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Codemode tool refresh failed for ${serverName}: ${message}`, "warning");
    }
  }

  /**
   * Regenerate type declarations, prompt summary, and the search index from the
   * current `mcpServers` and `config`. Shared by config refresh and tool re-list.
   */
  function regenerateDeclarations() {
    const nextBuiltin = generateBuiltinTypeDefs({ cli: config.cli });
    const nextMcp = generateMcpServerTypeDefs(mcpServers);
    builtinTypeDefs = nextBuiltin;
    mcpTypeDefs = nextMcp;
    typeCheckerTypeDefs = nextBuiltin + "\n" + nextMcp;
    mcpSummary = generateMcpSummaryForPrompt(mcpServers);
    buildSearchIndex(
      pi.getAllTools().map((t) => ({ name: t.name, description: t.description })),
      mcpServers,
      config.cli,
    );
  }

  /**
   * Re-read config and MCP metadata, reconcile servers, regenerate declarations,
   * rebuild the search index, and report the resulting capability summary.
   * In-flight executions keep their already-created bindings and are not aborted.
   * Note: a call already in flight on a server that is removed or changed by this
   * refresh may fail, because that server's connection is closed to pick up the
   * new config. Calls on unchanged servers are unaffected.
   */
  async function refreshSession(ctx: ExtensionContext): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const failures: string[] = [];
      const changes: string[] = [];

      // 1. Re-read codemode config.
      let nextConfig: CodemodeConfig;
      try {
        nextConfig = loadConfig();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`config: ${message}`);
        nextConfig = config;
      }

      // 2. Reconcile MCP servers (added/removed/changed).
      if (mcpClient) {
        try {
          const before = new Set(mcpClient.listServers());
          mcpServers = await mcpClient.refresh(nextConfig);
          const after = new Set(mcpClient.listServers());
          for (const name of after) if (!before.has(name)) changes.push(`added MCP server ${name}`);
          for (const name of before)
            if (!after.has(name)) changes.push(`removed MCP server ${name}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`mcp: ${message}`);
        }
      }

      // 3. Commit the new config, then regenerate declarations and the index.
      config = nextConfig;
      regenerateDeclarations();

      // 4. Report the capability summary (or failures).
      const toolCount = mcpServers.reduce((n, s) => n + s.tools.length, 0);
      const summary = [
        `Codemode refreshed: ${mcpServers.length} MCP server(s), ${toolCount} tool(s)`,
        ...changes,
      ].join("\n");
      if (failures.length > 0) {
        ctx.ui.notify(
          `Codemode refresh completed with errors:\n${failures.join("\n")}\n${summary}`,
          "warning",
        );
      } else {
        ctx.ui.notify(summary, "info");
      }
    } finally {
      refreshing = false;
    }
  }

  async function runJob(input: string, ctx: ExtensionContext): Promise<number> {
    try {
      const invocation = parseRunInvocation(input);
      const packageInfo = (() => {
        try {
          return resolveJobPackage(invocation.job, ctx.cwd || process.cwd());
        } catch {
          return undefined;
        }
      })();
      const entry = packageInfo?.entry ?? resolveJobEntry(invocation.job, ctx.cwd || process.cwd());
      const jobTypeDefs =
        generateBuiltinTypeDefs({ cli: config.cli, createFile: true }) + "\n" + mcpTypeDefs;
      const result = await executeCode(
        readJobEntry(entry),
        jobTypeDefs,
        getBindings(ctx.cwd || process.cwd(), undefined, undefined, ctx.mode, true),
        {
          timeout: config.executor?.timeoutMs ?? 120_000,
          executor: { kind: "quickjs" },
          args: invocation.args,
          enableCreateFile: true,
        },
      );
      for (const log of result.logs) process.stderr.write(log + "\n");
      if (!result.success) {
        process.stderr.write(result.errors.map((error) => error.message).join("\n") + "\n");
        return 1;
      }
      if (packageInfo?.handoff) {
        // Handoff is a normal model turn. Prepare the regular tool lifecycle first.
        prepareSession(ctx);
        handoffStarted = true;
        const prompt = renderHandoffPrompt(
          packageInfo.prompt ?? "",
          result.returnValue,
          invocation.args,
        );
        if (ctx.mode === "print" || ctx.mode === "json") await startHandoffTurn(prompt);
        else pi.sendUserMessage(prompt);
        return 0;
      }
      writeJobStdout(serializeJobResult(result.returnValue));
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  async function startHandoffTurn(prompt: string): Promise<void> {
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      pi.on("agent_start", async () => {
        started = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      });
      pi.on("agent_settled", async () => {
        if (started) {
          if (timer) clearTimeout(timer);
          resolve();
        }
      });
      timer = setTimeout(() => reject(new Error("Model handoff did not start")), 30_000);
    });
    pi.sendUserMessage(prompt);
    await settled;
  }

  function prepareSession(ctx: ExtensionContext) {
    const owned = new Set(codemodeOwnedTools());
    originalTools = pi.getActiveTools().filter((tool) => !owned.has(tool));
    buildSearchIndex(
      pi.getAllTools().map((t) => ({ name: t.name, description: t.description })),
      mcpServers,
      config.cli,
    );
    const startMode: CodemodeMode = pi.getFlag("no-codemode") ? "off" : config.mode;
    applyMode(startMode, ctx);
  }

  function applyMode(mode: CodemodeMode, ctx: ExtensionContext) {
    // Patch tools share one registration; flip path scope with the mode.
    fileScope.unrestricted = mode === "yolo";

    if (mode === "off") {
      deactivateCodemode();
      ctx.ui.notify("Codemode off — normal Pi tools active", "info");
      return;
    }

    const tools = codemodeTools(mode);
    pi.setActiveTools(tools);
    currentMode = mode;
    if (mode === "yolo" && !tools.includes("bash")) {
      ctx.ui.notify(
        "Codemode yolo requested but native bash is unavailable; using normal codemode tools",
        "warning",
      );
      return;
    }
    ctx.ui.notify(`Codemode ${mode} mode enabled`, "info");
  }

  function codemodeTools(mode: Exclude<CodemodeMode, "off">) {
    const tools = originalTools.filter(
      (tool) =>
        tool !== "bash" &&
        tool !== "write" &&
        // Do not activate an older execute_tools registration if a previous/other extension provides one.
        // This package intentionally registers only the Pi-facing codemode tool.
        tool !== "execute_tools" &&
        tool !== "codemode" &&
        tool !== "edit" &&
        tool !== "replace_in_file" &&
        tool !== "apply_patch",
    );
    tools.push("replace_in_file", "apply_patch", "codemode");
    if (mode === "yolo" && hasNativeBash()) {
      tools.push("bash");
    }
    return tools;
  }

  function hasNativeBash() {
    return pi.getAllTools().some((tool) => tool.name === "bash");
  }

  function deactivateCodemode() {
    // When leaving on/yolo, put back tools those modes strip (bash, edit, write).
    // When already starting in off, only drop codemode-owned names — don't invent tools.
    const leavingCodemode = currentMode !== "off";
    const desired = nativeToolsForOffMode({ restoreStripped: leavingCodemode });
    const current = pi.getActiveTools();
    if (!sameToolSet(current, desired)) {
      pi.setActiveTools(desired);
    }
    currentMode = "off";
  }

  function sameToolSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const setB = new Set(b);
    return a.every((name) => setB.has(name));
  }

  /**
   * Tools to activate when codemode is off: session baseline minus codemode-owned tools.
   * Optionally restore host tools that codemode modes intentionally strip (bash, edit, write),
   * even if the session_start snapshot omitted them (common with partial active sets).
   */
  function nativeToolsForOffMode(options: { restoreStripped: boolean }): string[] {
    const owned = new Set(codemodeOwnedTools());
    const allHost = pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !owned.has(name));
    const available = new Set(allHost);
    const baseline = originalTools.filter((tool) => !owned.has(tool) && available.has(tool));

    // Snapshot never captured native tools (only codemode-owned were active) — use full host set.
    if (baseline.length === 0) {
      return allHost;
    }

    const restored = [...baseline];
    if (options.restoreStripped) {
      // Modes strip bash/edit/write; put them back if the host still provides them.
      for (const name of ["bash", "edit", "write"] as const) {
        if (available.has(name) && !restored.includes(name)) {
          restored.push(name);
        }
      }
    }
    return restored;
  }

  function codemodeOwnedTools() {
    return ["codemode", "replace_in_file", "apply_patch"];
  }
}

/** Build the host sink for guest messages. Default output never enters model context. */
export function createSendMessageSink(
  pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
  mode: string | undefined,
): SendMessageFn {
  return async (params: SendMessageParams) => {
    if (params.display !== false && (mode !== "tui" || params.toModel !== true)) {
      if (mode === "tui") {
        pi.appendEntry(CODEMODE_MESSAGE_TYPE, {
          content: params.content,
          details: params.details,
        });
      } else {
        process.stderr.write(params.content + "\n");
      }
    }
    if (params.toModel === true) {
      pi.sendMessage({
        customType: CODEMODE_MESSAGE_TYPE,
        content: params.content,
        display: params.display ?? true,
        details: params.details,
      });
    }
  };
}

function createTopLevelFileTools(scope: FileScope): ToolDefinition[] {
  const fileTools = createFileTools({ scope });
  const textResult = (text: string) => ({ content: [{ type: "text", text }] });

  return [
    {
      name: "replace_in_file",
      label: "Replace in File",
      description:
        "Surgical fallback for tiny unique edits. Prefer apply_patch for reviewable change sets. Replace text using exact oldText/newText edits; every oldText must match exactly once and edits must not overlap.",
      parameters: objectSchema({
        path: stringSchema(),
        edits: arraySchema(
          objectSchema({
            oldText: stringSchema(),
            newText: stringSchema(),
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        return textResult(
          fileTools.replace_in_file(params as Parameters<typeof fileTools.replace_in_file>[0]),
        );
      },
      renderCall(args: unknown, theme: unknown, options?: unknown) {
        const diffTheme = theme as DiffTheme;
        const value = args as {
          path?: string;
          edits?: Array<{ oldText: string; newText: string }>;
        };
        const path = value.path ?? "file";
        const edits = value.edits ?? [];
        const preview = [`--- a/${path}`, `+++ b/${path}`, "@@"]
          .concat(edits.flatMap((edit) => [`-${edit.oldText}`, `+${edit.newText}`]))
          .join("\n");
        return new Text(
          diffTheme.fg("toolTitle", diffTheme.bold("replace_in_file")) +
            "\n" +
            renderCollapsibleDiffText(preview, diffTheme, isExpanded(options)),
          0,
          0,
        );
      },
      renderResult: renderFileToolResult,
    },
    {
      name: "apply_patch",
      label: "Apply Patch",
      description:
        "Preferred patch-native tool for reviewable change sets. Hunk lines are literal file text; do not JSON-escape quotes. Re-read before retry and use smaller failed hunks.",
      parameters: objectSchema({
        patch: stringSchema(),
      }),
      async execute(_toolCallId, params) {
        return textResult(
          fileTools.apply_patch(params as Parameters<typeof fileTools.apply_patch>[0]),
        );
      },
      renderCall(args: unknown, theme: unknown, options?: unknown) {
        const diffTheme = theme as DiffTheme;
        const patch =
          typeof args === "object" && args && "patch" in args
            ? String((args as { patch?: unknown }).patch ?? "")
            : "";
        return new Text(
          diffTheme.fg("toolTitle", diffTheme.bold("apply_patch")) +
            "\n" +
            renderCollapsibleDiffText(patch, diffTheme, isExpanded(options)),
          0,
          0,
        );
      },
      renderResult: renderFileToolResult,
    },
  ];
}

interface DiffTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  success?: (text: string) => string;
  error?: (text: string) => string;
}

function renderFileToolResult(result: unknown, options: unknown, theme: unknown) {
  const diffTheme = theme as DiffTheme;
  const fileResult = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = fileResult.content?.[0]?.text ?? "";
  const marker = fileResult.isError
    ? (diffTheme.error?.("✗ ") ?? "✗ ")
    : (diffTheme.success?.("✓ ") ?? "✓ ");
  const rendered = renderCollapsibleDiffText(text, diffTheme, isExpanded(options));
  return new Text(marker + rendered, 0, 0);
}

function isExpanded(options: unknown): boolean {
  return Boolean(
    typeof options === "object" &&
    options &&
    "expanded" in options &&
    (options as { expanded?: unknown }).expanded,
  );
}

function renderCollapsibleDiffText(text: string, theme: DiffTheme, expanded: boolean): string {
  const lines = text.split("\n");
  const maxCollapsedLines = 20;
  if (expanded || lines.length <= maxCollapsedLines) {
    return (
      renderDiffText(text, theme) +
      (expanded && lines.length > maxCollapsedLines ? "\n" + expandHint("to collapse") : "")
    );
  }
  const headCount = 10;
  const tailCount = 10;
  const hiddenCount = lines.length - headCount - tailCount;
  return (
    renderDiffText(lines.slice(0, headCount).join("\n"), theme) +
    "\n" +
    theme.fg("dim", `... ${hiddenCount} lines hidden (${expandHint("to expand")})`) +
    "\n" +
    renderDiffText(lines.slice(-tailCount).join("\n"), theme)
  );
}

function renderDiffText(text: string, theme: DiffTheme): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      if (line.startsWith("@@") || line.startsWith(" ")) return theme.fg("toolDiffContext", line);
      return line;
    })
    .join("\n");
}

function expandHint(description: "to expand" | "to collapse"): string {
  return `Ctrl+O ${description}`;
}

function stringSchema() {
  return { type: "string" } as const;
}

function arraySchema(items: unknown) {
  return { type: "array", items } as const;
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}
