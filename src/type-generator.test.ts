import { beforeAll, describe, expect, test } from "vitest";
import { initTypeChecker, typeCheck } from "./type-checker.js";
import { generateBuiltinTypeDefs, generateMcpServerTypeDefs } from "./type-generator.js";

beforeAll(() => {
  initTypeChecker();
});

describe("built-in file tool type definitions", () => {
  test("accept top-level Pi-shaped read, write, and edit", () => {
    const errors = typeCheck(
      `
const text = await read({ path: "src/index.ts" });
await write({ path: "out.txt", content: text });
await edit({
  path: "src/index.ts",
  edits: [{ oldText: "before", newText: "after" }],
});
`,
      generateBuiltinTypeDefs(),
    ).errors;

    expect(errors).toEqual([]);
  });

  test("rejects legacy codemode single-edit shape", () => {
    const errors = typeCheck(
      `await codemode.edit({ path: "x", oldText: "a", newText: "b" });`,
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
