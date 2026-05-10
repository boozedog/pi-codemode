import { describe, expect, test } from "vitest";
import { createToolBindings } from "./tool-bindings.js";
import type { McpServerInfo } from "./search.js";

const mcpServers: McpServerInfo[] = [
  {
    serverName: "github-mcp",
    namespace: "github",
    tools: [
      {
        name: "search_issues",
        description: "Search GitHub issues",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
      { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
    ],
  },
  { serverName: "slack", namespace: "slack", tools: [] },
];

describe("createToolBindings MCP discovery", () => {
  test("describes top-level file editing tools with usage guidance", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(bindings.describe_tools({ namespace: "codemode" })).resolves.toContain(
      "read/write/replace_in_file/apply_patch are top-level file tools",
    );
    await expect(
      bindings.describe_tools({ namespace: "codemode", tool: "replace_in_file" }),
    ).resolves.toContain("exact search/replace");
    await expect(
      bindings.describe_tools({ namespace: "codemode", tool: "write" }),
    ).resolves.toContain("new files or intentional complete rewrites");
    await expect(
      bindings.describe_tools({ namespace: "codemode", tool: "apply_patch" }),
    ).resolves.toContain("unified diff");
  });

  test("lists MCP servers without exposing them as top-level tools", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(bindings.list_mcp_servers()).resolves.toContain(
      "codemode.github — github-mcp (2 cached tools)",
    );
    expect(typeof bindings.github).toBe("object");
    expect(bindings.search_issues).toBeUndefined();
  });

  test("connects uncached MCP namespaces when listing tools", async () => {
    const uncached: McpServerInfo = { serverName: "context7", namespace: "context7", tools: [] };
    const bindings = createToolBindings({
      cwd: process.cwd(),
      mcpServers: [uncached],
      mcpClient: {
        available: true,
        getServers: () => [uncached],
        listServers: () => ["context7"],
        warmCache: async () => [uncached],
        ensureServerConnected: async () => ({
          serverName: "context7",
          namespace: "context7",
          tools: [
            {
              name: "resolve-library-id",
              description: "Resolve a Context7 library ID",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, libraryName: { type: "string" } },
                required: ["query", "libraryName"],
              },
            },
            { name: "query-docs", description: "Query docs", inputSchema: { type: "object" } },
          ],
        }),
        call: async () => "",
        shutdown: async () => undefined,
      },
    });

    await expect(bindings.list_tools({ namespace: "context7" })).resolves.toContain(
      "resolve_library_id(args: { query: string; libraryName: string; }) (MCP: resolve-library-id) — Resolve a Context7 library ID",
    );
    await expect(
      bindings.describe_tools({ namespace: "context7", tool: "resolve-library-id" }),
    ).resolves.toContain("query: string;");
  });

  test("lists MCP tools with pagination guidance", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(
      bindings.list_tools({ namespace: "github", offset: 1, limit: 1 }),
    ).resolves.toContain("codemode.github tools 2-2 of 2");
    await expect(
      bindings.list_tools({ namespace: "github", offset: 1, limit: 1 }),
    ).resolves.toContain("create_issue(args?: Record<string, unknown>) — Create an issue");
  });

  test("describe_tools points large namespace browsing to list_tools", async () => {
    const largeServer: McpServerInfo = {
      serverName: "large-mcp",
      namespace: "large",
      tools: Array.from({ length: 60 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: { type: "object" },
      })),
    };
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers: [largeServer] });

    const description = await bindings.describe_tools({ namespace: "large" });

    expect(description).toContain("showing 50 of 60 tools");
    expect(description).toContain('Use codemode.list_tools({ namespace: "large", offset: 50 })');
  });
});
