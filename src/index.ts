// index.ts — Pi Codemode extension entry point.
//
// Replaces Pi's tools with a single codemode tool that runs
// TypeScript code against typed tool APIs.
//
// This is a new implementation based on Cloudflare Codemode patterns,
// adapted for Pi's native tool system with QuickJS sandboxing.

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
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
import { initShell } from "./shell.js";
import { createFileTools } from "./file-tools.js";

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

  // Initialize the TypeScript type checker (pre-loads lib files, ~50ms)
  initTypeChecker();

  // --- Load configuration ---
  let config: CodemodeConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Codemode: config load failed: ${message}`);
    config = { mode: "on", executor: { type: "quickjs", timeoutMs: 120_000 } };
  }

  // --- Initialize shell integration ---
  void initShell({ projectRoot: process.cwd() }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Codemode: shell init failed: ${message}`);
  });

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
        console.warn(`Codemode: MCP cache warmup failed: ${message}`);
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Codemode: MCP init failed: ${message}`);
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
    bindings: getBindings(process.cwd()), // Initial bindings (will be recreated per call)
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
    handler: async (args: string[], ctx: ExtensionContext) => {
      const requested = args[0] as CodemodeMode | undefined;
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
    if (currentMode !== "off" && originalTools.length > 0) {
      pi.setActiveTools(originalTools);
    }
    currentMode = "off";
  }
}

interface ExtensionContext {
  ui: {
    notify(message: string, type: "info" | "warning" | "error" | "success"): void;
  };
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
        return textResult(fileTools.replace_in_file(params as Parameters<typeof fileTools.replace_in_file>[0]));
      },
    },
    {
      name: "apply_patch",
      label: "Apply Patch",
      description: "Apply a text-only unified diff safely inside the project root.",
      parameters: objectSchema({
        patch: stringSchema(),
      }),
      async execute(_toolCallId, params) {
        return textResult(fileTools.apply_patch(params as Parameters<typeof fileTools.apply_patch>[0]));
      },
    },
  ];
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

/**
 * Generate the system prompt addition for codemode.
 */
function generateSystemPromptAddition(
  builtinTypeDefs: string,
  mcpSummary: string,
  mode: Exclude<CodemodeMode, "off">,
): string {
  const modeGuidance =
    mode === "yolo"
      ? "In yolo mode, native bash is available and has broader host access. Prefer codemode for structured tool use and use bash for shell-heavy one-offs."
      : "In normal codemode, use codemode workflows and top-level non-bash tools. The native bash tool is not exposed.";
  return `\
## Code Mode (${mode})

${modeGuidance}

You have access to tools through TypeScript code execution. Instead of calling tools
individually, write TypeScript code that calls multiple tools and returns just what you need.

Your code is **type-checked** against the tool API before execution. Type errors are
returned for correction — no side effects occur until types are valid.

### Built-in Tool API

\`\`\`typescript
${builtinTypeDefs}
\`\`\`
${mcpSummary ? "\n" + mcpSummary + "\n" : ""}
### How to use

Call the top-level \`codemode\` tool with a TypeScript code body. Use top-level \`read\` for file inspection; file mutation helpers are intentionally unavailable inside guest code. Use top-level visible patch editing instead (see #21 for diff rendering). Use the in-guest \`codemode.*\` object for discovery and MCP tools. Prefer \`return\` for the final value. Use \`print()\` only for diagnostics or intermediate output you do not also return.

Top-level \`resultFormat\` controls rendering: use \`structured\`/\`json\` for parsed data, \`text\`/\`plain\` for agent-readable stdout-heavy command results with ANSI stripped, \`raw\` when exact stdout/stderr bytes or user-visible color/style are explicitly wanted, and \`auto\` to choose text for string/stdout-like values and structured JSON for objects. Prefer \`text\` for your own reasoning because some transcript/log surfaces show raw ANSI escapes literally; use \`raw\` only when the user wants color/styling or exact output.

If the result you need is primarily stdout/stderr from one or more CLI calls, return a plain string and set \`resultFormat: "text"\` instead of returning an object containing \`stdout\` fields. Avoid rendering stdout inside JSON unless you need machine-readable fields such as \`exitCode\`, parsed \`json\`, or multiple named values.

\`\`\`typescript
const [status, diff] = await Promise.all([
  cli.git.status({ short: true }),
  cli.git.diff({ stat: true }),
]);
return status.stdout + "\n" + diff.stdout;
\`\`\`

Use structured output when the JSON shape matters:
\`\`\`typescript
return {
  dirty: status.stdout.trim().length > 0,
  statusExit: status.exitCode,
  diffExit: diff.exitCode,
};
\`\`\`

#### Parallel execution — use Promise.all for independent calls

When you need data from multiple independent sources, **always** use \`Promise.all\` to
run them concurrently. This is significantly faster than sequential \`await\`s.

\`\`\`typescript
const [pkg, readme] = await Promise.all([
  read({ path: "package.json" }),
  read({ path: "README.md" }),
]);
return { deps: Object.keys(JSON.parse(pkg).dependencies || {}) };
\`\`\`

\`\`\`typescript
const [gitStatus, gitBranch] = await Promise.all([
  cli.git.status({ short: true }),
  cli.git.branch({ showCurrent: true }),
]);
return {
  dirty: gitStatus.stdout.trim().length > 0,
  branch: gitBranch.stdout.trim(),
};
\`\`\`

#### Chaining — use output of one call to drive the next

Chain calls when a later step depends on an earlier result.

\`\`\`typescript
// Step 1: Find files
const result = await cli.rg.search({ pattern: "describe|test|it", paths: ["src"], glob: ["*.test.ts"] });
const files = [...new Set(result.stdout.split('\\n').map(line => line.split(':')[0]).filter(Boolean))];

// Step 2: Read all found files in parallel
const contents = await Promise.all(
  files.map(f => read({ path: f }))
);

// Step 3: Extract and aggregate
const tests = contents.flatMap((c, i) => {
  const matches = c.match(/it\\(['"](.+?)['"]/g) || [];
  return matches.map(m => ({ file: files[i], test: m }));
});
return tests;
\`\`\`

#### Use search_tools and describe_tools for discovery

\`\`\`typescript
// Step 1: Browse tools in a namespace
const githubTools = await codemode.describe_tools({ namespace: "github" });
print(githubTools);

// Step 2: Get full parameter details for a specific tool
const details = await codemode.describe_tools({
  namespace: "github",
  tool: "search_issues"
});
print(details);

// Step 3: Call with the correct parameters
const issues = await codemode.github.search_issues({ query: "is:open label:bug" });
return issues;
\`\`\`

You can also use \`search_tools\` to find tools by keyword across all servers:
\`\`\`typescript
const found = await codemode.search_tools({ query: "slack direct messages" });
print(found);
\`\`\`

### String Constants (π)

When passing hard-to-quote text into guest code (backticks, \`\${}\` expressions, nested quotes, code blocks), pass it via the \`strings\` parameter instead of embedding it in your code. The strings are available as \`π.keyName\`.

\`\`\`typescript
return { script: π.script };
\`\`\`

**When to use \`strings\`:** File content with backticks, template literals, shell scripts,
code that contains string literals, or any text where JS quoting would be awkward.

**When NOT needed:** Simple strings, paths, short text without special characters.

${generateEditGuidance()}

### Important
- **Parallelize independent calls** — use \`Promise.all\` whenever calls don't depend on each other
- **Chain dependent calls** — use the result of one call to determine what to call next
- Both \`print()\` output and \`return\` values are included in the result; do not print the same value you return
- Type errors are caught before execution — fix them based on the error messages
- Runtime errors are caught and returned — fix your code if you see one
`;
}

function generateNativeEditGuidance(): string {
  return `\
## Native Tool Guidance

${generateEditGuidance()}`;
}

function generateEditGuidance(): string {
  return `\
### Edit guidance
- File mutation is patch-only and outside codemode guest code.
- Use the top-level visible patch editing tool for unified diffs scoped to the project root.
- Patch results should be rendered visibly in chat; see #21 for diff rendering.`;
}
