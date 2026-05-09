// index.ts — Pi Codemode extension entry point.
//
// Replaces Pi's tools with a single execute_tools tool that runs
// TypeScript code against typed tool APIs.
//
// This is a new implementation based on Cloudflare Codemode patterns,
// adapted for Pi's native tool system with Deno sandboxing.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { initTypeChecker } from "./type-checker.js";
import { buildSearchIndex } from "./search.js";

// Type-only imports for structures we'll implement
interface CodemodeConfig {
	executor?: {
		type: "deno" | "node-vm";
		timeoutMs?: number;
	};
	mcp?: {
		servers?: Record<string, unknown>;
	};
}

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

	// Initialize the TypeScript type checker (pre-loads lib files, ~50ms)
	initTypeChecker();

	// --- Load configuration ---
	// TODO: Use config in Phase 2
	void loadConfig();

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
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
		buildSearchIndex(piTools);

		// Activate codemode: only execute_tools visible to LLM
		activateCodemode();

		ctx.ui.notify("Codemode enabled — TypeScript tool execution active", "info");
	});

	// --- Shutdown ---

	pi.on("session_shutdown", async () => {
		// Cleanup any active executors
		// TODO: shutdown executors
	});

	// --- System prompt injection ---

	pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
		if (!enabled) return;

		const addition = generateSystemPromptAddition();
		return {
			systemPrompt: event.systemPrompt + "\n\n" + addition,
		};
	});

	// --- Toggle command ---

	pi.registerCommand("codemode", {
		description: "Toggle code mode on/off",
		handler: async (_args, ctx) => {
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

	// --- Register execute_tools tool (Phase 2) ---
	// TODO: Import and register execute_tools
	// const executeTool = createExecuteTool({ ... });
	// pi.registerTool(executeTool);

	// --- Helpers ---

	function activateCodemode() {
		// For now, we don't actually hide other tools since execute_tools isn't registered yet
		// In Phase 2: pi.setActiveTools(["execute_tools"]);
		enabled = true;
	}

	function deactivateCodemode() {
		if (originalTools.length > 0) {
			pi.setActiveTools(originalTools);
		}
		enabled = false;
	}
}

/**
 * Load codemode configuration from global and project config files.
 */
function loadConfig(): CodemodeConfig {
	// TODO: Implement config loading from:
	// - ~/.pi/agent/codemode.json (global)
	// - $PROJECT/.pi/codemode.json (project)
	return {
		executor: {
			type: "deno",
			timeoutMs: 120_000,
		},
	};
}

/**
 * Generate the system prompt addition for codemode.
 */
function generateSystemPromptAddition(): string {
	return `\
## Code Mode

You have access to tools through TypeScript code execution. Instead of calling tools
individually, write TypeScript code that calls multiple tools and returns just what you need.

Your code is **type-checked** against the tool API before execution. Type errors are
returned for correction — no side effects occur until types are valid.

### How to use

Call \`execute_tools\` with a TypeScript code body. Your code runs with the \`codemode.*\` API
available. Use \`print()\` to output intermediate results and \`return\` for the final value.

#### Parallel execution — use Promise.all for independent calls

When you need data from multiple independent sources, **always** use \`Promise.all\` to
run them concurrently.

\`\`\`typescript
const [pkg, readme] = await Promise.all([
  codemode.read({ path: "package.json" }),
  codemode.read({ path: "README.md" }),
]);
return { deps: Object.keys(JSON.parse(pkg).dependencies || {}) };
\`\`\`

#### Use search_tools and describe_tools for discovery

- \`codemode.search_tools({ query: "file read" })\` — find tools by keyword
- \`codemode.describe_tools({ namespace: "github" })\` — list tools in a namespace
- \`codemode.describe_tools({ namespace: "github", tool: "search_issues" })\` — see parameters

### String Constants (π)

Pass file content via the \`strings\` parameter to avoid escaping issues:

\`\`\`typescript
await codemode.write({ path: "run.sh", content: π.script });
\`\`\`

**Note:** Codemode is currently in early development. Full tool API coming soon.
`;
}
