// system-prompt.ts — Codemode system-prompt additions (pure string builders).

import type { CodemodeMode } from "./config.js";

/**
 * Generate the system prompt addition for codemode.
 */
export function generateSystemPromptAddition(
  builtinTypeDefs: string,
  mcpSummary: string,
  mode: Exclude<CodemodeMode, "off">,
): string {
  const modeGuidance =
    mode === "yolo"
      ? "In yolo mode, native bash is available and has broader host access. Prefer codemode for structured tool use and use bash for shell-heavy one-offs."
      : "In normal codemode, use codemode workflows and top-level non-bash tools. The native bash tool is not exposed. Writes are restricted to the project root and go through the root-scoped patch tools (replace_in_file / apply_patch); native write/edit/bash are not exposed.";
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

Call the top-level \`codemode\` tool with a TypeScript code body. Use top-level \`read\` for file inspection; file mutation helpers are intentionally unavailable inside guest code. Use top-level visible patch editing instead (patch results render as diffs in chat). Use the in-guest \`codemode.*\` object for discovery and MCP tools. Prefer \`return\` for the final value. Use \`print()\` only for diagnostics or intermediate output you do not also return.

Write human-readable, nicely formatted TypeScript with normal line breaks in codemode calls. Avoid cramming multiple statements into one long line; the code is shown in the transcript while it runs and should be easy for the user to review.

Top-level \`resultFormat\` controls rendering: use \`structured\`/\`json\` for parsed data, \`text\`/\`plain\` for agent-readable stdout-heavy command results with ANSI stripped, \`raw\` when exact stdout/stderr bytes or user-visible color/style are explicitly wanted, and \`auto\` to choose text for string/stdout-like values and structured JSON for objects. Prefer \`text\` for your own reasoning because some transcript/log surfaces show raw ANSI escapes literally; use \`raw\` only when the user wants color/styling or exact output.

Large tool calls/results may be visually collapsed in the transcript; use Ctrl+O to expand them when you need the hidden middle content.

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

export function generateNativeEditGuidance(): string {
  return `\
## Native Tool Guidance

${generateEditGuidance()}`;
}

export function generateEditGuidance(): string {
  return `\
### Edit guidance
- File mutation is patch-only and outside codemode guest code.
- Use the top-level visible patch editing tool for unified diffs (project-root scoped in on mode; in yolo absolute paths may reach anywhere, matching bash).
- Patch results should be rendered visibly in chat.`;
}
