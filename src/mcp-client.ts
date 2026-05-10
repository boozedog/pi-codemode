// mcp-client.ts — Codemode-only MCP client with lazy connections and cache integration.
//
// Uses pi-mcp-adapter's metadata cache for instant tool discovery. MCP tools are
// exposed only inside codemode, not registered as top-level Pi tools.

import { McpServerManager } from "pi-mcp-adapter/server-manager.js";
import { loadMcpConfig } from "pi-mcp-adapter/config.js";
import {
  computeServerHash,
  isServerCacheValid,
  loadMetadataCache,
  saveMetadataCache,
  serializeResources,
  serializeTools,
} from "pi-mcp-adapter/metadata-cache.js";
import { transformMcpContent } from "pi-mcp-adapter/tool-registrar.js";
import type { McpContent } from "pi-mcp-adapter/types.js";
import type { CodemodeConfig } from "./config.js";
import type { McpServerInfo, McpToolInfo } from "./search.js";

/** Optional error enrichment function for tool call failures */
export type ErrorEnricher = (inputSchema: unknown) => string;

export interface McpClientOptions {
  /** Optional function to enrich error messages with schema info */
  enrichError?: ErrorEnricher;
  /** Codemode-specific config merged on top of pi-mcp-adapter config. */
  config?: CodemodeConfig;
}

export interface McpClient {
  /** Get info about all known servers (from cache, no connections needed). */
  getServers(): McpServerInfo[];

  /** Connect to a server if needed and return fresh tool metadata. */
  ensureServerConnected(namespace: string): Promise<McpServerInfo>;

  /** Call a tool on a specific server. Lazy-connects if needed. */
  call(namespace: string, toolName: string, args?: Record<string, unknown>): Promise<string>;

  /** Start connecting all configured servers to populate metadata cache. */
  warmCache(): Promise<McpServerInfo[]>;

  /** List all configured server names. */
  listServers(): string[];

  /** Clean up all connections. */
  shutdown(): Promise<void>;

  /** Whether any MCP servers are configured. */
  readonly available: boolean;
}

/**
 * Create a codemode-only MCP client.
 */
export function createMcpClient(options?: McpClientOptions): McpClient {
  const enrichError = options?.enrichError;
  const manager = new McpServerManager();
  const adapterConfig = loadMcpConfig();
  const config = {
    ...adapterConfig,
    mcpServers: {
      ...adapterConfig.mcpServers,
      ...options?.config?.mcp?.servers,
    },
  };
  const serverNames = Object.keys(config.mcpServers ?? {});
  const cache = loadMetadataCache();

  const servers = new Map<string, McpServerInfo>();
  const namespaceToServer = new Map<string, string>();
  const connectedServers = new Set<string>();

  for (const serverName of serverNames) {
    const namespace = toNamespace(serverName);
    namespaceToServer.set(namespace, serverName);

    const def = config.mcpServers[serverName];
    const cached = cache?.servers?.[serverName];

    if (cached && def && isServerCacheValid(cached, def)) {
      servers.set(namespace, {
        serverName,
        namespace,
        tools: cached.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    } else {
      servers.set(namespace, {
        serverName,
        namespace,
        tools: [],
      });
    }
  }

  async function ensureConnected(namespace: string): Promise<void> {
    const serverName = namespaceToServer.get(namespace);
    if (!serverName) {
      const available = [...namespaceToServer.keys()].join(", ");
      throw new Error(
        `Unknown MCP server namespace: "${namespace}". Available: ${available || "none"}`,
      );
    }
    if (connectedServers.has(serverName)) return;

    const def = config.mcpServers[serverName];
    if (!def) throw new Error(`No config for MCP server: "${serverName}"`);

    let connection;
    try {
      connection = await manager.connect(serverName, def);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to connect MCP server "${serverName}" (codemode.${namespace}): ${message}`,
      );
    }

    if (connection.status === "needs-auth") {
      throw new Error(
        `MCP server "${serverName}" (codemode.${namespace}) requires authentication. Configure/authenticate it in pi-mcp-adapter first.`,
      );
    }

    const tools: McpToolInfo[] = connection.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    servers.set(namespace, { serverName, namespace, tools });
    connectedServers.add(serverName);

    try {
      saveMetadataCache({
        version: 1,
        servers: {
          [serverName]: {
            configHash: computeServerHash(def),
            tools: serializeTools(connection.tools),
            resources: serializeResources(connection.resources),
            cachedAt: Date.now(),
          },
        },
      });
    } catch {
      // Cache persistence is best-effort; do not fail an otherwise valid MCP connection.
    }
  }

  return {
    get available() {
      return serverNames.length > 0;
    },

    getServers() {
      return [...servers.values()];
    },

    async ensureServerConnected(namespace) {
      await ensureConnected(namespace);
      return servers.get(namespace)!;
    },

    async call(namespace, toolName, args) {
      await ensureConnected(namespace);

      const info = servers.get(namespace)!;
      const resolvedToolName = resolveMcpToolName(info.tools, toolName);
      if (info.tools.length > 0 && !resolvedToolName) {
        const available = info.tools.map((t) => t.name).join(", ");
        throw new Error(
          `Unknown MCP tool: codemode.${namespace}.${toolName}(). Available: ${available}`,
        );
      }
      const mcpToolName = resolvedToolName ?? toolName;

      const connection = manager.getConnection(info.serverName);
      if (!connection) {
        throw new Error(`MCP server "${info.serverName}" failed to connect`);
      }

      manager.touch(info.serverName);
      manager.incrementInFlight(info.serverName);

      try {
        const result = await connection.client.callTool({
          name: mcpToolName,
          arguments: args ?? {},
        });

        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent);
        const textParts = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);

        const text = textParts.join("\n") || "(empty result)";

        if (result.isError) {
          const toolInfo = info.tools.find((t) => t.name === mcpToolName);
          let errorMsg = `MCP tool error: codemode.${namespace}.${toolName}()\n\n${text}`;
          if (toolInfo?.inputSchema) {
            if (enrichError) {
              errorMsg += `\n\n${enrichError(toolInfo.inputSchema)}`;
            }
          }
          throw new Error(errorMsg);
        }

        return text;
      } finally {
        manager.decrementInFlight(info.serverName);
      }
    },

    async warmCache() {
      await Promise.all(serverNames.map((serverName) => ensureConnected(toNamespace(serverName))));
      return [...servers.values()];
    },

    listServers() {
      return serverNames;
    },

    async shutdown() {
      await manager.closeAll();
      connectedServers.clear();
    },
  };
}

function toNamespace(serverName: string): string {
  let ns = serverName.replace(/-?mcp$/i, "").replace(/[^a-zA-Z0-9_$]/g, "_");
  if (!ns) ns = "mcp";
  if (/^[0-9]/.test(ns)) ns = "_" + ns;
  return ns;
}

function resolveMcpToolName(tools: McpToolInfo[], requestedName: string): string | undefined {
  if (tools.some((t) => t.name === requestedName)) return requestedName;
  const match = tools.find((t) => sanitizeToolName(t.name) === requestedName);
  return match?.name;
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
