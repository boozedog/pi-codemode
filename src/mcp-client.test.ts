// mcp-client.test.ts — MCP client polish tests.

import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  connectFails: true,
  needsAuth: false,
  savedCache: undefined as unknown,
  saveCacheFails: false,
  toolResult: {
    content: [{ type: "text", text: "ok" }],
    isError: false,
  } as unknown,
}));

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
    getConnection(): unknown {
      return {
        client: {
          callTool: async () => state.toolResult,
        },
      };
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
  saveMetadataCache: (cache: unknown) => {
    if (state.saveCacheFails) throw new Error("cache write failed");
    state.savedCache = cache;
  },
  serializeResources: () => [],
  serializeTools: (tools: unknown) => tools,
}));

vi.mock("pi-mcp-adapter/tool-registrar.js", () => ({
  transformMcpContent: (content: unknown) => content,
}));

import { createMcpClient } from "./mcp-client.js";

describe("mcp client", () => {
  beforeEach(() => {
    state.connectFails = true;
    state.needsAuth = false;
    state.savedCache = undefined;
    state.saveCacheFails = false;
    state.toolResult = {
      content: [{ type: "text", text: "ok" }],
      isError: false,
    };
  });

  test("merges codemode-specific MCP servers into adapter config", () => {
    const client = createMcpClient({
      config: {
        executor: { type: "quickjs", timeoutMs: 120_000 },
        mcp: {
          servers: {
            linear: { command: "linear" },
            slack: { command: "project-slack" },
          },
        },
      },
    });

    expect(client.listServers()).toEqual(["github-mcp", "slack", "linear"]);
    expect(client.getServers().map((s) => s.namespace)).toEqual(["github", "slack", "linear"]);
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

  test("successful connection refreshes metadata cache", async () => {
    state.connectFails = false;
    const client = createMcpClient();

    await expect(client.call("github", "serch_issues", {})).rejects.toThrow("Unknown MCP tool");

    expect(state.savedCache).toEqual({
      version: 1,
      servers: {
        "github-mcp": {
          configHash: "hash",
          tools: [
            { name: "search_issues", description: "Search issues", inputSchema: {} },
            { name: "create_issue", description: "Create issue", inputSchema: {} },
          ],
          resources: [],
          cachedAt: expect.any(Number),
        },
      },
    });
  });

  test("metadata cache write failure does not block connected tool metadata", async () => {
    state.connectFails = false;
    state.saveCacheFails = true;
    const client = createMcpClient();

    await expect(client.call("github", "serch_issues", {})).rejects.toThrow(
      "Unknown MCP tool: codemode.github.serch_issues(). Available: search_issues, create_issue",
    );
  });

  test("calls a connected fake MCP tool and returns transformed text", async () => {
    state.connectFails = false;
    const client = createMcpClient();

    await expect(client.call("github", "search_issues", { query: "bug" })).resolves.toBe("ok");
  });

  test("enriches MCP tool errors with schema hints for self correction", async () => {
    state.connectFails = false;
    state.toolResult = {
      content: [{ type: "text", text: "missing query" }],
      isError: true,
    };
    const client = createMcpClient({
      enrichError: () => "Parameters:\n  query (required): string",
    });

    await expect(client.call("github", "search_issues", {})).rejects.toThrow(
      "Parameters:\n  query (required): string",
    );
  });
});
