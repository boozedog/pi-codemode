import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Resolve a coreutil on PATH (NixOS has no /bin/echo or /usr/bin/true). */
function systemCommand(name: string): string {
  return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "pi-codemode-tool-bindings-test-"));
  dirs.push(dir);
  return dir;
}

describe("createToolBindings sendMessage", () => {
  test("routes sendMessage to the provided sink", () => {
    const sink = vi.fn<() => void>();
    const bindings = createToolBindings({ cwd: process.cwd(), sendMessage: sink });

    bindings.sendMessage!({ content: "hello", display: false });

    expect(sink).toHaveBeenCalledWith({ content: "hello", display: false });
  });

  test("sendMessage defaults to a no-op when no sink is provided", () => {
    const bindings = createToolBindings({ cwd: process.cwd() });

    expect(() => bindings.sendMessage!({ content: "x" })).not.toThrow();
  });
});

describe("createToolBindings MCP discovery", () => {
  test("plans npm scripts from package.json as visible cli calls", async () => {
    const cwd = tempProject();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { check: "npm run build && npm test", build: "tsc", test: "vitest run" },
      }),
    );
    const bindings = createToolBindings({ cwd, mcpServers });

    await expect(bindings.plan_npm_script({ script: "check" })).resolves.toContain(
      "Plan for npm run check:\n- cli.tsc.build({})\n- cli.vitest.run({})",
    );
  });

  test("runs npm scripts by executing only decomposed cli calls", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const bindings = createToolBindings({
      cwd,
      mcpServers,
      cli: { tsc: { backend: "host", command: systemCommand("true"), operations: ["build"] } },
    });

    await expect(bindings.run_npm_script({ script: "build" })).resolves.toContain(
      "Executed cli.tsc.build({}) -> exit 0",
    );
  });

  test("runs npm scripts compactly unless verbose output is requested", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "tsc --watch" } }));
    const bindings = createToolBindings({
      cwd,
      mcpServers,
      cli: { tsc: { backend: "host", command: systemCommand("echo"), operations: ["build"] } },
    });

    const compact = await bindings.run_npm_script({ script: "dev" });
    const verbose = await bindings.run_npm_script({ script: "dev", verbose: true });

    expect(compact).not.toContain("--watch");
    expect(verbose).toContain("--watch");
  });

  test("stops npm script execution on the first non-zero cli exit", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const bindings = createToolBindings({
      cwd,
      mcpServers,
      cli: { tsc: { backend: "host", command: systemCommand("false"), operations: ["build"] } },
    });

    await expect(bindings.run_npm_script({ script: "build" })).resolves.toContain(
      "Stopped after cli.tsc.build({}) failed with exit 1",
    );
  });

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

  test("calls MCP tools through the preferred mcp namespace", async () => {
    const call = vi.fn<() => Promise<string>>(async () => "ok");
    const bindings = createToolBindings({
      cwd: process.cwd(),
      mcpServers,
      mcpClient: {
        available: true,
        getServers: () => mcpServers,
        listServers: () => ["github-mcp", "slack"],
        warmCache: async () => mcpServers,
        ensureServerConnected: async () => mcpServers[0],
        call,
        refresh: async () => mcpServers,
        refreshServerTools: async () => mcpServers,
        shutdown: async () => undefined,
      },
    });

    await expect(
      (bindings.mcp as Record<string, Record<string, unknown>>).github.search_issues,
    ).toBeDefined();
    await expect(
      (
        (bindings.mcp as Record<string, Record<string, (args: unknown) => Promise<string>>>).github
          .search_issues as (args: unknown) => Promise<string>
      )({ query: "test" }),
    ).resolves.toBe("ok");
    expect(call).toHaveBeenCalledWith("github", "search_issues", { query: "test" });
  });

  test("lists MCP servers without exposing them as top-level tools", async () => {
    const bindings = createToolBindings({ cwd: process.cwd(), mcpServers });

    await expect(bindings.list_mcp_servers()).resolves.toContain(
      "mcp.github — github-mcp (2 cached tools)",
    );
    expect(typeof bindings.mcp).toBe("object");
    expect(typeof (bindings.mcp as Record<string, unknown>).github).toBe("object");
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
        refresh: async () => [uncached],
        refreshServerTools: async () => [uncached],
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
    ).resolves.toContain("mcp.github tools 2-2 of 2");
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
