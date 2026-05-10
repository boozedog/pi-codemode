// mcp-client.test.ts — MCP client polish tests.

import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ connectFails: true, needsAuth: false }));

vi.mock("pi-mcp-adapter/server-manager.js", () => {
  class McpServerManager {
    async connect(): Promise<unknown> {
      if (state.connectFails) throw new Error("should not connect in this test");
      return {
        status: state.needsAuth ? "needs-auth" : "connected",
        tools: [
          { name: "search_issues", description: "Search issues", inputSchema: {} },
          { name: "create_issue", description: "Create issue", inputSchema: {} },
        ],
        resources: [],
      };
    }
    getConnection(): undefined {
      return undefined;
    }
    touch(): void {}
    incrementInFlight(): void {}
    decrementInFlight(): void {}
    async closeAll(): Promise<void> {}
  }
  return { McpServerManager };
});

vi.mock("pi-mcp-adapter/config.js", () => ({
  loadMcpConfig: () => ({
    mcpServers: {
      "github-mcp": { command: "github" },
      slack: { command: "slack" },
    },
  }),
}));

vi.mock("pi-mcp-adapter/metadata-cache.js", () => ({
  computeServerHash: () => "hash",
  isServerCacheValid: () => false,
  loadMetadataCache: () => null,
  saveMetadataCache: () => {},
  serializeResources: () => [],
  serializeTools: () => [],
}));

vi.mock("pi-mcp-adapter/tool-registrar.js", () => ({
  transformMcpContent: (content: unknown) => content,
}));

import { createMcpClient } from "./mcp-client.js";

describe("mcp client", () => {
  beforeEach(() => {
    state.connectFails = true;
    state.needsAuth = false;
  });

  test("unknown namespace error lists available namespaces", async () => {
    const client = createMcpClient();

    await expect(client.call("gitub", "search_issues", {})).rejects.toThrow(
      'Unknown MCP server namespace: "gitub". Available: github, slack',
    );
  });

  test("connection failure names the server and namespace", async () => {
    const client = createMcpClient();

    await expect(client.call("github", "search_issues", {})).rejects.toThrow(
      'Failed to connect MCP server "github-mcp" (codemode.github): should not connect in this test',
    );
  });

  test("unknown tool error lists available tools after connect", async () => {
    state.connectFails = false;
    const client = createMcpClient();

    await expect(client.call("github", "serch_issues", {})).rejects.toThrow(
      "Unknown MCP tool: codemode.github.serch_issues(). Available: search_issues, create_issue",
    );
  });

  test("auth-required error names the server and namespace", async () => {
    state.connectFails = false;
    state.needsAuth = true;
    const client = createMcpClient();

    await expect(client.call("github", "search_issues", {})).rejects.toThrow(
      'MCP server "github-mcp" (codemode.github) requires authentication. Configure/authenticate it in pi-mcp-adapter first.',
    );
  });
});
