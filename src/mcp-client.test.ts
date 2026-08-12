import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  computeServerHash,
  connectWithUrlFallback,
  createMcpClient,
  flattenMcpContent,
  httpRequestInit,
  isRetryableUrlTransportError,
  isUnsupportedAuthError,
  loadMcpServers,
  projectRoot,
} from "./mcp-client.js";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixture = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }) + "\\n");
  } else if (request.method === "notifications/initialized") {
    return;
  } else if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "search-issues", description: "Search", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (request.method === "tools/call") {
    const isError = request.params?.arguments?.fail === true;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: isError ? "missing query" : "ok" }], isError } }) + "\\n");
  }
});
`;

function stdioServer() {
  return { command: process.execPath, args: ["-e", fixture] };
}

async function isolatedClient(extra: Parameters<typeof createMcpClient>[0] = {}) {
  const projectDir = await tempDir("codemode-mcp-project-");
  const homeDir = await tempDir("codemode-mcp-home-");
  const cachePath = join(projectDir, "mcp-metadata.json");
  return createMcpClient({
    projectDir,
    homeDir,
    cachePath,
    ...extra,
  });
}

describe("MCP config merge", () => {
  test("loads global then project MCP files", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    const homeDir = await tempDir("codemode-mcp-home-");
    await mkdir(join(homeDir, ".config", "mcp"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "mcp", "mcp.json"),
      JSON.stringify({
        mcpServers: { global: { command: "global" }, shared: { command: "global" } },
      }),
    );
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "project" }, project: { command: "project" } },
      }),
    );

    expect(loadMcpServers(projectDir, homeDir)).toEqual({
      global: { command: "global" },
      shared: { command: "project" },
      project: { command: "project" },
    });
  });

  test("merges file servers, Codemode config, then explicit overrides", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    const homeDir = await tempDir("codemode-mcp-home-");
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "file" }, file: { command: "file" } } }),
    );

    const client = createMcpClient({
      projectDir,
      homeDir,
      cachePath: join(projectDir, "cache.json"),
      config: {
        mode: "on",
        executor: { type: "quickjs", timeoutMs: 1_000 },
        mcp: {
          servers: {
            shared: { command: "codemode" },
            linear: { command: "linear" },
          },
        },
      },
      servers: {
        shared: { command: "override" },
        slack: { command: "slack" },
      },
    });

    expect(client.listServers()).toEqual(["shared", "file", "linear", "slack"]);
    expect(client.getServers().map((server) => server.namespace)).toEqual([
      "shared",
      "file",
      "linear",
      "slack",
    ]);
  });

  test("reports invalid MCP JSON with the file path", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    const homeDir = await tempDir("codemode-mcp-home-");
    const path = join(projectDir, ".mcp.json");
    await writeFile(path, "{");

    expect(() => loadMcpServers(projectDir, homeDir)).toThrow(`Invalid MCP config JSON: ${path}`);
  });
});

describe("MCP helpers", () => {
  test("flattens text content and ignores non-text blocks", () => {
    expect(flattenMcpContent([])).toBe("(empty result)");
    expect(
      flattenMcpContent([
        { type: "text", text: "one" },
        { type: "image", data: "abc" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });

  test("builds URL headers from config headers and bearer tokens", () => {
    expect(
      httpRequestInit({
        url: "https://example.test/mcp",
        headers: { "X-Test": "1" },
        bearerToken: "secret",
      }),
    ).toEqual({
      headers: {
        "X-Test": "1",
        Authorization: "Bearer secret",
      },
    });
  });

  test("resolves adapter-style bearerTokenEnv into an Authorization header", () => {
    const envName = "CODEMODE_TEST_BEARER";
    const previous = process.env[envName];
    process.env[envName] = "from-env";
    try {
      expect(
        httpRequestInit({
          url: "https://example.test/mcp",
          auth: "bearer",
          bearerTokenEnv: envName,
        }),
      ).toEqual({
        headers: { Authorization: "Bearer from-env" },
      });
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("classifies auth errors as unsupported OAuth and not retryable", () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), { name: "UnauthorizedError" });
    expect(isUnsupportedAuthError(unauthorized)).toBe(true);
    expect(isRetryableUrlTransportError(unauthorized)).toBe(false);
    expect(isRetryableUrlTransportError(new Error("404 Not Found"))).toBe(true);
  });

  test("does not treat HTTP 401 as a retryable SSE fallback", () => {
    const unauthorized = new Error("SSE error: Non-200 status code (401)");
    expect(isUnsupportedAuthError(unauthorized)).toBe(true);
    expect(isRetryableUrlTransportError(unauthorized)).toBe(false);
  });

  test("falls back from Streamable HTTP to SSE on retryable transport failure", async () => {
    const kinds: string[] = [];
    const result = await connectWithUrlFallback(
      { url: "https://example.test/mcp", bearerToken: "secret" },
      async (kind, url, requestInit) => {
        kinds.push(kind);
        expect(url.toString()).toBe("https://example.test/mcp");
        expect(requestInit).toEqual({ headers: { Authorization: "Bearer secret" } });
        if (kind === "http") throw new Error("404 Not Found");
        return "sse-ok";
      },
    );

    expect(kinds).toEqual(["http", "sse"]);
    expect(result).toEqual({ kind: "sse", value: "sse-ok" });
  });

  test("does not fall back to SSE when the server requires OAuth", async () => {
    await expect(
      connectWithUrlFallback({ url: "https://example.test/mcp" }, async () => {
        throw Object.assign(new Error("Unauthorized"), { name: "UnauthorizedError" });
      }),
    ).rejects.toThrow("OAuth browser flows are not supported");
  });

  test("does not fall back to SSE after a 401", async () => {
    const kinds: string[] = [];
    await expect(
      connectWithUrlFallback({ url: "https://example.test/mcp" }, async (kind) => {
        kinds.push(kind);
        throw new Error("SSE error: Non-200 status code (401)");
      }),
    ).rejects.toThrow(/requires authentication|OAuth browser flows are not supported|401/);
    expect(kinds).toEqual(["http"]);
  });
});

describe("McpClient", () => {
  test("uses a real stdio SDK connection to list and call tools", async () => {
    const client = await isolatedClient({ servers: { "github-mcp": stdioServer() } });
    await expect(client.call("github", "search_issues", { q: "bug" })).resolves.toBe("ok");
    expect(client.getServers()[0]?.tools[0]?.name).toBe("search-issues");
    await client.shutdown();
  });

  test("maps unknown namespaces and sanitized tool names", async () => {
    const client = await isolatedClient({ servers: { github: stdioServer() } });
    await expect(client.call("gitub", "search", {})).rejects.toThrow(
      "Unknown MCP server namespace",
    );
    await expect(client.call("github", "search_issues", {})).resolves.toBe("ok");
    await client.shutdown();
  });

  test("enriches MCP tool errors with schema hints", async () => {
    const client = await isolatedClient({
      servers: { github: stdioServer() },
      enrichError: () => "Parameters:\n  query (required): string",
    });
    await expect(client.call("github", "search_issues", { fail: true })).rejects.toThrow(
      "Parameters:\n  query (required): string",
    );
    await client.shutdown();
  });

  test("hydrates tool metadata from a matching disk cache without connecting", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    const homeDir = await tempDir("codemode-mcp-home-");
    const cachePath = join(projectDir, "mcp-metadata.json");
    const servers = { github: { command: "cached-only" } };
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        servers: {
          github: {
            configHash: computeServerHash(servers.github),
            tools: [{ name: "search-issues", description: "Search", inputSchema: {} }],
            cachedAt: Date.now(),
          },
        },
      }),
    );

    const client = createMcpClient({ projectDir, homeDir, cachePath, servers });
    expect(client.getServers()[0]?.tools[0]?.name).toBe("search-issues");
  });

  test("writes metadata cache after a successful stdio connection", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    const homeDir = await tempDir("codemode-mcp-home-");
    const cachePath = join(projectDir, "cache", "mcp-metadata.json");
    const servers = { github: stdioServer() };
    const client = createMcpClient({ projectDir, homeDir, cachePath, servers });
    await client.call("github", "search_issues", {});
    await client.shutdown();

    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      servers: { github: { configHash: string; tools: Array<{ name: string }> } };
    };
    expect(cached.servers.github.configHash).toBe(computeServerHash(servers.github));
    expect(cached.servers.github.tools[0]?.name).toBe("search-issues");
  });

  test("warmCache keeps healthy servers when one URL server fails auth", async () => {
    const client = await isolatedClient({
      servers: {
        github: stdioServer(),
        litellm: { url: "https://example.test/mcp" },
      },
    });
    const warmed = await client.warmCache();
    expect(warmed.find((server) => server.namespace === "github")?.tools[0]?.name).toBe(
      "search-issues",
    );
    expect(warmed.find((server) => server.namespace === "litellm")?.tools).toEqual([]);
    await client.shutdown();
  });

  test("advertises the project directory as an MCP root", async () => {
    const projectDir = await tempDir("codemode-mcp-project-");
    expect(projectRoot(projectDir)).toEqual({
      uri: `file://${projectDir}`,
      name: "project",
    });
  });
});
