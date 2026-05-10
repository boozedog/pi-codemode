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
  test("lists MCP servers without exposing them as top-level tools", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(bindings.list_mcp_servers()).resolves.toContain(
      "codemode.github — github-mcp (2 cached tools)",
    );
    expect(typeof bindings.github).toBe("object");
    expect(bindings.search_issues).toBeUndefined();
  });

  test("lists MCP tools with pagination guidance", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(
      bindings.list_tools({ namespace: "github", offset: 1, limit: 1 }),
    ).resolves.toContain("codemode.github tools 2-2 of 2");
    await expect(
      bindings.list_tools({ namespace: "github", offset: 1, limit: 1 }),
    ).resolves.toContain("create_issue — Create an issue");
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
