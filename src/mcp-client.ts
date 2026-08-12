// Codemode-only MCP client. The official SDK is deliberately wrapped here so
// callers do not depend on a particular transport or SDK release.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CodemodeConfig } from "./config.js";
import type { McpServerInfo, McpToolInfo } from "./search.js";

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  auth?: "oauth" | "bearer" | false;
  bearerTokenEnv?: string;
  debug?: boolean;
};

export type ErrorEnricher = (inputSchema: unknown) => string;

export interface McpClientOptions {
  enrichError?: ErrorEnricher;
  config?: CodemodeConfig;
  /** Override config files and SDK construction in focused tests. */
  servers?: Record<string, McpServerConfig>;
  projectDir?: string;
  homeDir?: string;
  cachePath?: string;
}

export interface McpClient {
  getServers(): McpServerInfo[];
  ensureServerConnected(namespace: string): Promise<McpServerInfo>;
  call(namespace: string, toolName: string, args?: Record<string, unknown>): Promise<string>;
  warmCache(): Promise<McpServerInfo[]>;
  listServers(): string[];
  shutdown(): Promise<void>;
  readonly available: boolean;
}

type UrlTransportKind = "http" | "sse";

type MetadataCache = {
  version: 1;
  servers: Record<
    string,
    {
      configHash: string;
      tools: McpToolInfo[];
      cachedAt: number;
    }
  >;
};

const OAUTH_UNSUPPORTED =
  "OAuth browser flows are not supported. Configure bearerToken, bearerTokenEnv, or headers, or use a stdio server.";

/** Load global and project MCP files. CodemodeConfig is merged by createMcpClient. */
export function loadMcpServers(
  projectDir = process.cwd(),
  homeDir = homedir(),
): Record<string, McpServerConfig> {
  const project = readJson(join(projectDir, ".mcp.json"));
  const global = readJson(join(homeDir, ".config", "mcp", "mcp.json"));
  return {
    ...asServers(global),
    ...asServers(project),
  };
}

export function computeServerHash(def: McpServerConfig): string {
  return createHash("sha256").update(stableStringify(def)).digest("hex");
}

export function flattenMcpContent(content: unknown[]): string {
  const text = content.flatMap((item) =>
    item && typeof item === "object" && "text" in item && typeof item.text === "string"
      ? [item.text]
      : [],
  );
  return text.join("\n") || "(empty result)";
}

export function httpRequestInit(
  def: McpServerConfig,
): { headers: Record<string, string> } | undefined {
  const token = resolveBearerToken(def);
  const headers = {
    ...def.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return Object.keys(headers).length > 0 ? { headers } : undefined;
}

export function isUnsupportedAuthError(err: unknown): boolean {
  if (UnauthorizedError.isInstance(err)) return true;
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return (
    name === "UnauthorizedError" ||
    name === "OAuthError" ||
    name === "OAuthClientFlowError" ||
    /oauth|unauthorized|authentication required|needs.?auth|status code \(401\)|\b401\b/i.test(
      err.message,
    )
  );
}

export function isRetryableUrlTransportError(err: unknown): boolean {
  if (isUnsupportedAuthError(err)) return false;
  if (!(err instanceof Error)) return true;
  return !/oauth browser flows are not supported/i.test(err.message);
}

export async function connectWithUrlFallback<T>(
  def: McpServerConfig,
  connect: (
    kind: UrlTransportKind,
    url: URL,
    requestInit: { headers: Record<string, string> } | undefined,
  ) => Promise<T>,
): Promise<{ kind: UrlTransportKind; value: T }> {
  if (!def.url) throw new Error("MCP server must define command or url");
  const url = new URL(def.url);
  const requestInit = httpRequestInit(def);
  try {
    return { kind: "http", value: await connect("http", url, requestInit) };
  } catch (err) {
    if (isUnsupportedAuthError(err)) throw oauthUnsupportedError(err);
    if (!isRetryableUrlTransportError(err)) throw err;
    try {
      return { kind: "sse", value: await connect("sse", url, requestInit) };
    } catch (sseErr) {
      if (isUnsupportedAuthError(sseErr)) throw oauthUnsupportedError(sseErr);
      throw sseErr;
    }
  }
}

export function createMcpClient(options?: McpClientOptions): McpClient {
  const enrichError = options?.enrichError;
  const projectDir = options?.projectDir ?? process.cwd();
  const homeDir = options?.homeDir ?? homedir();
  const cachePath = options?.cachePath ?? defaultCachePath(homeDir);
  const configured = {
    ...loadMcpServers(projectDir, homeDir),
    ...(options?.config?.mcp?.servers as Record<string, McpServerConfig> | undefined),
    ...options?.servers,
  };
  const serverNames = Object.keys(configured);
  const cache = loadMetadataCache(cachePath);
  const servers = new Map<string, McpServerInfo>();
  const namespaceToServer = new Map<string, string>();
  const connections = new Map<string, Client>();
  const connecting = new Map<string, Promise<void>>();

  for (const name of serverNames) {
    const namespace = toNamespace(name);
    namespaceToServer.set(namespace, name);
    const def = configured[name];
    const cached = def ? cache.servers[name] : undefined;
    servers.set(namespace, {
      serverName: name,
      namespace,
      tools: cached && def && cached.configHash === computeServerHash(def) ? cached.tools : [],
    });
  }

  async function ensureConnected(namespace: string): Promise<void> {
    const serverName = namespaceToServer.get(namespace);
    if (!serverName) {
      throw new Error(
        `Unknown MCP server namespace: "${namespace}". Available: ${[...namespaceToServer.keys()].join(", ") || "none"}`,
      );
    }
    if (connections.has(serverName)) return;
    const existing = connecting.get(serverName);
    if (existing) return existing;
    const promise = connect(serverName, namespace);
    connecting.set(serverName, promise);
    try {
      await promise;
    } finally {
      connecting.delete(serverName);
    }
  }

  async function connect(serverName: string, namespace: string): Promise<void> {
    const def = configured[serverName];
    if (!def) throw new Error(`No config for MCP server: "${serverName}"`);
    let client: Client | undefined;
    try {
      client = await openClient(def, projectDir);
      const result = await client.listTools();
      const tools = (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      servers.set(namespace, { serverName, namespace, tools });
      connections.set(serverName, client);
      persistServerCache(cachePath, cache, serverName, def, tools);
    } catch (err) {
      await client?.close().catch(() => undefined);
      if (
        isUnsupportedAuthError(err) ||
        /oauth browser flows are not supported/i.test(errorMessage(err))
      ) {
        throw new Error(
          `MCP server "${serverName}" (mcp.${namespace}) requires authentication. ${OAUTH_UNSUPPORTED}`,
        );
      }
      throw new Error(
        `Failed to connect MCP server "${serverName}" (mcp.${namespace}): ${errorMessage(err)}`,
      );
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
      const resolved = resolveMcpToolName(info.tools, toolName);
      if (info.tools.length > 0 && !resolved)
        throw new Error(
          `Unknown MCP tool: mcp.${namespace}.${toolName}(). Available: ${info.tools.map((t) => t.name).join(", ")}`,
        );
      const client = connections.get(info.serverName)!;
      const result = await client.callTool({ name: resolved ?? toolName, arguments: args ?? {} });
      const text = flattenMcpContent(result.content ?? []);
      if (result.isError) {
        let message = `MCP tool error: mcp.${namespace}.${toolName}()\n\n${text}`;
        const schema = info.tools.find((t) => t.name === (resolved ?? toolName))?.inputSchema;
        if (schema && enrichError) message += `\n\n${enrichError(schema)}`;
        throw new Error(message);
      }
      return text;
    },
    async warmCache() {
      await Promise.all(
        serverNames.map((name) => ensureConnected(toNamespace(name)).catch(() => undefined)),
      );
      return [...servers.values()];
    },
    listServers() {
      return serverNames;
    },
    async shutdown() {
      await Promise.allSettled([...connections.values()].map((client) => client.close()));
      connections.clear();
    },
  };
}

export function projectRoot(projectDir: string): { uri: string; name: string } {
  const path = resolve(projectDir);
  return { uri: pathToFileUri(path), name: "project" };
}

async function openClient(def: McpServerConfig, projectDir: string): Promise<Client> {
  if (def.auth === "oauth") {
    throw oauthUnsupportedError(new Error("auth=oauth"));
  }
  if (def.command) {
    const client = newClient(projectDir);
    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env: def.env,
      cwd: def.cwd,
      stderr: def.debug ? "inherit" : "ignore",
    });
    try {
      await client.connect(transport);
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  const connected = await connectWithUrlFallback(def, async (kind, url, requestInit) => {
    const client = newClient(projectDir);
    const options = requestInit ? { requestInit } : undefined;
    const transport =
      kind === "http"
        ? new StreamableHTTPClientTransport(url, options)
        : new SSEClientTransport(url, options);
    try {
      await client.connect(transport);
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  });
  return connected.value;
}

function newClient(projectDir: string): Client {
  const client = new Client(
    { name: "pi-codemode", version: packageVersion() },
    { capabilities: { roots: { listChanged: true } } },
  );
  const root = projectRoot(projectDir);
  client.setRequestHandler("roots/list", async () => ({ roots: [root] }));
  return client;
}

function pathToFileUri(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return encodeURI(`file://${normalized.startsWith("/") ? "" : "/"}${normalized}`);
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function defaultCachePath(homeDir: string): string {
  return join(homeDir, ".cache", "pi-codemode", "mcp-metadata.json");
}

function loadMetadataCache(path: string): MetadataCache {
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MetadataCache;
    if (parsed?.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") {
      return { version: 1, servers: {} };
    }
    return parsed;
  } catch {
    return { version: 1, servers: {} };
  }
}

function persistServerCache(
  path: string,
  cache: MetadataCache,
  serverName: string,
  def: McpServerConfig,
  tools: McpToolInfo[],
): void {
  cache.servers[serverName] = {
    configHash: computeServerHash(def),
    tools,
    cachedAt: Date.now(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, servers: cache.servers }, null, 2)}\n`);
  } catch {
    // Cache persistence is best-effort; do not fail an otherwise valid MCP connection.
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Invalid MCP config JSON: ${path}: ${errorMessage(err)}`);
  }
}

function asServers(value: unknown): Record<string, McpServerConfig> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const servers = record.mcpServers ?? record.servers;
  return servers && typeof servers === "object" ? (servers as Record<string, McpServerConfig>) : {};
}

function oauthUnsupportedError(err: unknown): Error {
  return new Error(`${OAUTH_UNSUPPORTED} (${errorMessage(err)})`);
}

function resolveBearerToken(def: McpServerConfig): string | undefined {
  if (def.bearerToken) return def.bearerToken;
  if (!def.bearerTokenEnv) return undefined;
  const value = process.env[def.bearerTokenEnv];
  return value && value.length > 0 ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toNamespace(serverName: string): string {
  let ns = serverName.replace(/-?mcp$/i, "").replace(/[^a-zA-Z0-9_$]/g, "_");
  if (!ns) ns = "mcp";
  return /^[0-9]/.test(ns) ? `_${ns}` : ns;
}

function resolveMcpToolName(tools: McpToolInfo[], requested: string): string | undefined {
  if (tools.some((tool) => tool.name === requested)) return requested;
  return tools.find((tool) => sanitizeToolName(tool.name) === requested)?.name;
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
