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
import { createFileTools } from "./file-tools.js";
import { generateNativeEditGuidance, generateSystemPromptAddition } from "./system-prompt.js";

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

  // --- State ---

  let currentMode: CodemodeMode = "off";
  let originalTools: string[] = [];
  let mcpClient: McpClient | undefined;
  let mcpServers: McpServerInfo[] = [];
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
    mcpClient = createMcpClient({ config, enrichError: generateParamSummary });
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
  const builtinTypeDefs = generateBuiltinTypeDefs({ cli: config.cli });
  const mcpTypeDefs = generateMcpServerTypeDefs(mcpServers);
  const typeCheckerTypeDefs = builtinTypeDefs + "\n" + mcpTypeDefs;
  const mcpSummary = generateMcpSummaryForPrompt(mcpServers);

  // --- Create tool bindings factory ---
  function getBindings(
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (update: {
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }) => void,
  ) {
    return createToolBindings({
      cwd,
      mcpServers,
      mcpClient,
      cli: config.cli,
      signal,
      onUpdate,
    });
  }

  // --- Register codemode tools ---

  for (const tool of createTopLevelFileTools(process.cwd())) {
    pi.registerTool(tool);
  }

  const executeTool = createExecuteTool({
    typeDefs: typeCheckerTypeDefs,
    getBindings: ({ signal, onUpdate, cwd }) => getBindings(cwd ?? process.cwd(), signal, onUpdate),
    timeout: config.executor?.timeoutMs ?? 120_000,
    executor: { kind: config.executor?.type ?? "quickjs" },
  });

  pi.registerTool(executeTool);

  // --- Session lifecycle ---

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // Store original tool set for toggling
    originalTools = pi.getActiveTools();

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
    description: "Set code mode: on, yolo, off (bare toggles off <-> on)",
    handler: async (args: string, ctx: ExtensionContext) => {
      // Pi passes the raw text after `/codemode` as one string, e.g. "yolo".
      const requested = args.trim().split(/\s+/).find(Boolean) as CodemodeMode | undefined;
      if (requested && !["off", "on", "yolo"].includes(requested)) {
        ctx.ui.notify("Usage: /codemode [on|yolo|off]", "warning");
        return;
      }
      applyMode(requested ?? (currentMode === "off" ? "on" : "off"), ctx);
    },
  });

  // --- Helpers ---

  function applyMode(mode: CodemodeMode, ctx: ExtensionContext) {
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
    const nativeTools = originalTools.filter((tool) => !codemodeOwnedTools().includes(tool));
    if (currentMode !== "off" && nativeTools.length > 0) {
      pi.setActiveTools(nativeTools);
    } else if (currentMode === "off" && nativeTools.length !== originalTools.length) {
      pi.setActiveTools(nativeTools);
    }
    currentMode = "off";
  }

  function codemodeOwnedTools() {
    return ["codemode", "replace_in_file", "apply_patch"];
  }
}

function createTopLevelFileTools(projectRoot: string): ToolDefinition[] {
  const fileTools = createFileTools({ projectRoot });
  const textResult = (text: string) => ({ content: [{ type: "text", text }] });

  return [
    {
      name: "replace_in_file",
      label: "Replace in File",
      description:
        "Replace text in a file using exact oldText/newText edits. Every oldText must match exactly once and edits must not overlap.",
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
      renderResult: renderFileToolResult,
    },
    {
      name: "apply_patch",
      label: "Apply Patch",
      description: "Apply a text-only unified diff safely inside the project root.",
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
