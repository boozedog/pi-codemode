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

  test("documents the read offset contract truthfully", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(typeDefs).toContain("offset?: number");
    expect(typeDefs).toMatch(/zero-based line offset/i);
    expect(typeDefs).not.toContain("Each line is prefixed with line number and hash");
    expect(typeDefs).not.toContain("1-indexed");
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

  test("interactive type defs do not declare or type-check createFile", () => {
    const typeDefs = generateBuiltinTypeDefs();
    expect(typeDefs).not.toContain("declare function createFile");
    expect(
      typeCheck(`await createFile({ path: "x", content: "y" });`, typeDefs).errors,
    ).not.toEqual([]);
  });

  test("job type defs declare createFile but keep mutating helpers unavailable", () => {
    const typeDefs = generateBuiltinTypeDefs({ createFile: true });
    expect(typeDefs).toContain("declare function createFile");
    expect(typeCheck(`await createFile({ path: "x", content: "y" });`, typeDefs).errors).toEqual(
      [],
    );
    expect(typeCheck(`await write({ path: "x", content: "y" });`, typeDefs).errors).not.toEqual([]);
    expect(
      typeCheck(
        `await replace_in_file({ path: "x", edits: [{ oldText: "a", newText: "b" }] });`,
        typeDefs,
      ).errors,
    ).not.toEqual([]);
    expect(
      typeCheck(`await apply_patch({ patch: "--- a/x\n+++ b/x\n" });`, typeDefs).errors,
    ).not.toEqual([]);
  });

  test("types sendMessage as a top-level tool and inside codemode namespace", () => {
    const typeDefs = generateBuiltinTypeDefs();

    expect(typeDefs).toContain("declare function sendMessage");
    expect(typeDefs).toContain("content: string");

    expect(typeCheck(`sendMessage({ content: "hi" });`, typeDefs).errors).toEqual([]);
    expect(typeCheck(`sendMessage({ content: "hi", display: false });`, typeDefs).errors).toEqual(
      [],
    );
    expect(typeCheck(`await codemode.sendMessage({ content: "hi" });`, typeDefs).errors).toEqual(
      [],
    );
  });
});

describe("MCP server type definitions", () => {
  test("exposes MCP servers under the mcp namespace", () => {
    const typeDefs =
      generateBuiltinTypeDefs() +
      generateMcpServerTypeDefs([
        {
          serverName: "GitHub",
          namespace: "github",
          tools: [{ name: "search_issues", inputSchema: { type: "object" } }],
        },
      ]);

    expect(typeDefs).toContain("declare const mcp: McpServerNamespaces;");
    expect(typeCheck("await mcp.github.search_issues({});", typeDefs).errors).toEqual([]);
  });

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

  test("parenthesizes array item unions so enum arrays type-check", () => {
    // Regression: without parens, TS parses `"a" | "b"[]` as `"a" | ("b"[])`.
    const typeDefs = generateMcpServerTypeDefs([
      {
        serverName: "firecrawl",
        namespace: "firecrawl",
        tools: [
          {
            name: "scrape",
            description: "Scrape a URL",
            inputSchema: {
              type: "object",
              properties: {
                formats: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["markdown", "html", "rawHtml", "links", "screenshot", "audio"],
                  },
                },
                categories: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["github", "research", "pdf"],
                  },
                },
              },
            },
          },
        ],
      },
    ]);

    expect(typeDefs).toContain(
      'formats?: ("markdown" | "html" | "rawHtml" | "links" | "screenshot" | "audio")[];',
    );
    expect(typeDefs).toContain('categories?: ("github" | "research" | "pdf")[];');
    // Unparenthesized form must not appear (binds `[]` only to the last union member).
    expect(typeDefs).not.toContain(
      'formats?: "markdown" | "html" | "rawHtml" | "links" | "screenshot" | "audio"[];',
    );
    expect(typeDefs).not.toContain('categories?: "github" | "research" | "pdf"[];');

    const errors = typeCheck(
      `await codemode.firecrawl.scrape({
        formats: ["markdown", "links"],
        categories: ["github", "pdf"],
      });`,
      generateBuiltinTypeDefs() + "\n" + typeDefs,
    ).errors;
    expect(errors).toEqual([]);
  });
});
