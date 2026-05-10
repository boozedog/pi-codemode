// mcp-client.test.ts — MCP client polish tests.

import { describe, expect, test, vi } from "vitest";

vi.mock("pi-mcp-adapter/server-manager.js", () => {
  class McpServerManager {
    async connect(): Promise<never> {
      throw new Error("should not connect in this test");
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
});
