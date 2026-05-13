import { beforeAll, describe, expect, test } from "vitest";
import { initTypeChecker, typeCheck } from "./type-checker.js";
import { generateBuiltinTypeDefs, generateMcpServerTypeDefs } from "./type-generator.js";

beforeAll(() => {
  initTypeChecker();
});

describe("built-in file tool type definitions", () => {
  test("accepts top-level read but rejects mutating file helpers in guest code", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(
      typeCheck(`const text = await read({ path: "src/index.ts" });`, typeDefs).errors,
    ).toEqual([]);
    expect(
      typeCheck(`await write({ path: "out.txt", content: "x" });`, typeDefs).errors,
    ).not.toEqual([]);
    expect(
      typeCheck(
        `await replace_in_file({ path: "src/index.ts", edits: [{ oldText: "before", newText: "after" }] });`,
        typeDefs,
      ).errors,
    ).not.toEqual([]);
    expect(
      typeCheck(`await apply_patch({ patch: "--- a/x\n+++ b/x\n" });`, typeDefs).errors,
    ).not.toEqual([]);
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

  test("documents patch-only mutation outside guest code", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(typeDefs).toContain("declare function read");
    expect(typeDefs).not.toContain("declare function write");
    expect(typeDefs).not.toContain("declare function replace_in_file");
    expect(typeDefs).not.toContain("declare function apply_patch");
    expect(typeDefs).toContain(
      "File mutation is intentionally not available inside codemode guest code",
    );
    expect(typeDefs).toContain("Use the top-level visible patch editing tool instead");
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
