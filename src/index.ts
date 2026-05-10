// index.ts — Pi Codemode extension entry point.
//
// Replaces Pi's tools with a single execute_tools tool that runs
// TypeScript code against typed tool APIs.
//
// This is a new implementation based on Cloudflare Codemode patterns,
// adapted for Pi's native tool system with QuickJS sandboxing.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
import { loadConfig } from "./config.js";
import { initShell } from "./shell.js";

export default function codemodeExtension(pi: ExtensionAPI) {
  // --- Configuration ---

  pi.registerFlag("no-codemode", {
    description: "Disable code mode (use normal tools)",
    type: "boolean",
    default: false,
  });

  // --- State ---

  let enabled = true;
  let originalTools: string[] = [];
  let mcpClient: McpClient | undefined;
  let mcpServers: McpServerInfo[] = [];

  // Initialize the TypeScript type checker (pre-loads lib files, ~50ms)
  initTypeChecker();

  // --- Load configuration ---
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Codemode: config load failed: ${message}`);
    config = { executor: { type: "quickjs" as const, timeoutMs: 120_000 } };
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Codemode: MCP init failed: ${message}`);
    mcpServers = [];
  }

  // --- Build type definitions ---
  const builtinTypeDefs = generateBuiltinTypeDefs();
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
      signal,
      onUpdate,
    });
  }

  // --- Register execute_tools tool ---

  const executeTool = createExecuteTool({
    typeDefs: typeCheckerTypeDefs,
    bindings: getBindings(process.cwd()), // Initial bindings (will be recreated per call)
    timeout: config.executor?.timeoutMs ?? 120_000,
    executor: { kind: config.executor?.type ?? "quickjs" },
  });

  pi.registerTool(executeTool);

  // --- Session lifecycle ---

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const noCodemode = pi.getFlag("no-codemode") as boolean;
    if (noCodemode) {
      enabled = false;
      ctx.ui.notify("Codemode disabled via --no-codemode", "info");
      return;
    }

    // Store original tool set for toggling
    originalTools = pi.getActiveTools();

    // Build search index over all Pi tools
    const piTools = pi.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    buildSearchIndex(piTools, mcpServers);

    // Activate codemode: only execute_tools visible to LLM
    activateCodemode();

    ctx.ui.notify("Codemode enabled — TypeScript tool execution active", "info");
  });

  // --- Shutdown ---

  pi.on("session_shutdown", async () => {
    if (mcpClient) {
      await mcpClient.shutdown();
    }
  });

  // --- System prompt injection ---

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    const addition = enabled
      ? generateSystemPromptAddition(builtinTypeDefs, mcpSummary)
      : generateNativeEditGuidance();

    return {
      systemPrompt: event.systemPrompt + "\n\n" + addition,
    };
  });

  // --- Toggle command ---

  pi.registerCommand("codemode", {
    description: "Toggle code mode on/off",
    handler: async (_args: string[], ctx: ExtensionContext) => {
      enabled = !enabled;

      if (enabled) {
        activateCodemode();
        ctx.ui.notify("Codemode enabled", "info");
      } else {
        deactivateCodemode();
        ctx.ui.notify("Codemode disabled — all tools available", "info");
      }
    },
  });

  // --- Helpers ---

  function activateCodemode() {
    pi.setActiveTools(["execute_tools"]);
    enabled = true;
  }

  function deactivateCodemode() {
    if (originalTools.length > 0) {
      pi.setActiveTools(originalTools);
    }
    enabled = false;
  }
}

interface ExtensionContext {
  ui: {
    notify(message: string, type: "info" | "warning" | "error" | "success"): void;
  };
}

/**
 * Generate the system prompt addition for codemode.
 */
function generateSystemPromptAddition(builtinTypeDefs: string, mcpSummary: string): string {
  return `\
## Code Mode

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

Call \`execute_tools\` with a TypeScript code body. Use top-level \`read\`, \`write\`, and
\`edit\` for files; use \`codemode.*\` for discovery and MCP tools. Use \`print()\` to output
intermediate results and \`return\` for the final value.

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
  $\`git status --porcelain\`,
  $\`git branch --show-current\`,
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
const result = await $\`find src -name '*.test.ts'\`;
const files = result.stdout.split('\\n').filter(f => f.trim());

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

When writing or editing files with content that's hard to quote in JavaScript (backticks,
\`\${}\` expressions, nested quotes, code blocks), pass the content via the \`strings\`
parameter instead of embedding it in your code. The strings are available as \`π.keyName\`.

\`\`\`typescript
await write({ path: "run.sh", content: π.script });
await edit({
  path: "config.ts",
  edits: [{ oldText: π.oldConfig, newText: π.newConfig }],
});
\`\`\`

**When to use \`strings\`:** File content with backticks, template literals, shell scripts,
code that contains string literals, or any text where JS quoting would be awkward.

**When NOT needed:** Simple strings, paths, short text without special characters.

${generateEditGuidance()}

### Important
- **Parallelize independent calls** — use \`Promise.all\` whenever calls don't depend on each other
- **Chain dependent calls** — use the result of one call to determine what to call next
- Both \`print()\` output and \`return\` values are included in the result
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
- When using \`edit\`, \`oldText\` must be an exact literal substring from the original file
- Each \`oldText\` must match exactly once
- Edits are matched against the original file, not sequentially
- Edits must not overlap
- If two changes are close together, merge them into one larger edit
- Use enough surrounding context to make \`oldText\` unique, but avoid huge unrelated blocks`;
}
