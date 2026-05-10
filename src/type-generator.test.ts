import { beforeAll, describe, expect, test } from "vitest";
import { initTypeChecker, typeCheck } from "./type-checker.js";
import { generateBuiltinTypeDefs, generateMcpServerTypeDefs } from "./type-generator.js";

beforeAll(() => {
  initTypeChecker();
});

describe("built-in file tool type definitions", () => {
  test("accept top-level Pi-shaped read, write, replace_in_file, and apply_patch", () => {
    const errors = typeCheck(
      `
const text = await read({ path: "src/index.ts" });
await write({ path: "out.txt", content: text });
await replace_in_file({
  path: "src/index.ts",
  edits: [{ oldText: "before", newText: "after" }],
});
await apply_patch({ patch: "--- a/x\\n+++ b/x\\n@@ -1,1 +1,1 @@\\n-a\\n+b\\n" });
`,
      generateBuiltinTypeDefs(),
    ).errors;

    expect(errors).toEqual([]);
  });

  test("does not expose replace_in_file through codemode namespace", () => {
    const errors = typeCheck(
      `await codemode.replace_in_file({ path: "x", edits: [{ oldText: "a", newText: "b" }] });`,
      generateBuiltinTypeDefs(),
    ).errors;

    expect(errors).not.toEqual([]);
  });

  test("generates usable codemode built-in tool signatures without Cloudflare runtime imports", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(typeDefs).toContain("search_tools(args: {");
    expect(typeDefs).toContain("query: string;");
    expect(typeDefs).toContain("progress(args: {");
    expect(typeDefs).toContain("message: string;");
  });

  test("documents when to use write and exact replace_in_file semantics", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(typeDefs).toContain("Use for new files or intentional complete rewrites");
    expect(typeDefs).toContain("Avoid full-file rewrites for small localized changes");
    expect(typeDefs).toContain("Replace text in a file (replace_in_file)");
    expect(typeDefs).toContain("Use for precise localized changes");
    expect(typeDefs).toContain("declare function apply_patch");
    expect(typeDefs).toContain("oldText must match exactly one unique, non-overlapping region");
    expect(typeDefs).toContain("merge nearby edits into one larger replacement");
  });
});

describe("MCP server type definitions", () => {
  test("sanitizes tool and namespace names and maps JSON schema properties", () => {
    const typeDefs = generateMcpServerTypeDefs([
      {
        serverName: "GitHub",
        namespace: "github-api",
        tools: [
          {
            name: "search/issues",
            description: "Search issues",
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string" },
                limit: { type: "integer" },
              },
              required: ["q"],
            },
          },
        ],
      },
    ]);

    expect(typeDefs).toContain("github_api: McpGithubApiTools;");
    expect(typeDefs).toContain("search_issues(args: {");
    expect(typeDefs).toContain("q: string;");
    expect(typeDefs).toContain("limit?: number;");
  });
});
