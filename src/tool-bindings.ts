// tool-bindings.ts — Create runtime bindings that back the TypeScript type declarations.
//
// Each binding wraps a real Pi tool implementation and returns simplified values.
// MCP tools are exposed as nested namespaces (e.g., codemode.github.search_issues).

import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { searchTools } from "./search.js";
import { createCliBindings } from "./cli.js";
import { generateToolSignature, generateParamSummary } from "./type-generator.js";
import type { CliConfig } from "./config.js";
import { createFileTools } from "./file-tools.js";
import type { McpClient } from "./mcp-client.js";
import type { McpServerInfo } from "./search.js";

/** The shape the sandbox code sees at runtime */
export interface ToolBindings {
  read(params: { path: string; offset?: number; limit?: number }): Promise<string>;
  write(params: { path: string; content: string }): Promise<void>;
  replace_in_file(params: {
    path: string;
    edits: Array<{ oldText: string; newText: string }>;
  }): Promise<string>;
  apply_patch(params: { patch: string }): Promise<string>;
  search_tools(params: { query: string }): Promise<string>;
  list_mcp_servers(): Promise<string>;
  list_tools(params: { namespace: string; offset?: number; limit?: number }): Promise<string>;
  describe_tools(params: { namespace: string; tool?: string }): Promise<string>;
  cli: Record<string, unknown>;
  progress(message: string): void;
  /** MCP server namespaces are added dynamically */
  [serverNamespace: string]: unknown;
}

export interface ToolBindingsOptions {
  cwd: string;
  /** MCP server info for tool discovery */
  mcpServers?: McpServerInfo[];
  /** MCP client for lazy tool execution */
  mcpClient?: McpClient;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Configured typed CLI capabilities */
  cli?: CliConfig;
  /** Callback for streaming progress to the UI */
  onUpdate?: AgentToolUpdateCallback;
}

/**
 * Create the tool binding functions.
 *
 * These bindings wrap host-side implementations and are callable from the sandbox
 * via the host bridge. File tools use Node.js fs directly with path validation
 * to ensure operations stay within the project directory.
 */
export function createToolBindings(options: ToolBindingsOptions): ToolBindings {
  const { cwd, mcpServers, mcpClient, signal, onUpdate } = options;

  // Create file tools scoped to the project directory
  const fileTools = createFileTools({ projectRoot: cwd });

  const bindings: ToolBindings = {
    async read(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      return fileTools.read(params);
    },

    async write(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      return fileTools.write(params);
    },

    async replace_in_file(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      return fileTools.replace_in_file(params);
    },

    async apply_patch(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      return fileTools.apply_patch(params);
    },

    async search_tools(params) {
      return searchTools(params.query);
    },

    async list_mcp_servers() {
      if (!mcpServers || mcpServers.length === 0) {
        return "No MCP servers available.";
      }
      return mcpServers
        .map(
          (server) =>
            `codemode.${server.namespace} — ${server.serverName} (${server.tools.length} cached tools)`,
        )
        .join("\n");
    },

    async list_tools(params) {
      if (!mcpServers || mcpServers.length === 0) {
        return "No MCP servers available.";
      }
      const server = await getFreshServerInfo(params.namespace);
      if (!server) {
        const available = mcpServers.map((s) => s.namespace).join(", ");
        return `Unknown namespace "${params.namespace}". Available: ${available || "none"}`;
      }
      return listServerTools(server, params.offset, params.limit);
    },

    cli: createCliBindings(options.cli, cwd, signal),

    async describe_tools(params) {
      // Handle built-in tools
      if (params.namespace === "codemode") {
        return describeBuiltinTools(params.tool);
      }

      // Handle MCP servers
      if (!mcpServers || mcpServers.length === 0) {
        return "No MCP servers available.";
      }

      const server = await getFreshServerInfo(params.namespace);
      if (!server) {
        const available = mcpServers.map((s) => s.namespace).join(", ");
        return `Unknown namespace "${params.namespace}". Available: ${available || "none"}`;
      }

      if (!params.tool) {
        // List all tools in this namespace
        if (server.tools.length === 0) {
          return `codemode.${server.namespace} has no cached tools. Call any tool to trigger a connection.`;
        }
        return listServerTools(server, 0, 50);
      }

      // Describe a specific tool
      const tool = server.tools.find((t) => t.name === params.tool);
      if (!tool) {
        const names = server.tools.map((t) => t.name).join(", ");
        return `Unknown tool "${params.tool}" in codemode.${server.namespace}. Available: ${names}`;
      }

      return generateToolSignature(server.namespace, tool.name, tool.description, tool.inputSchema);
    },

    progress(message: string) {
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: message }],
          details: { progress: true },
        });
      }
    },
  };

  async function getFreshServerInfo(namespace: string): Promise<McpServerInfo | undefined> {
    const cached = mcpServers?.find((s) => s.namespace === namespace);
    if (!cached) return undefined;
    if (cached.tools.length > 0 || !mcpClient) return cached;
    return mcpClient.ensureServerConnected(namespace);
  }

  // Add per-server MCP namespaces as proxies
  // These will be callable as codemode.<namespace>.<tool>(args)
  if (mcpServers) {
    for (const server of mcpServers) {
      const serverProxy: Record<string, (args?: Record<string, unknown>) => Promise<string>> = {};

      for (const tool of server.tools) {
        serverProxy[tool.name] = async (args?: Record<string, unknown>) => {
          if (signal?.aborted) throw new Error("Execution cancelled");
          if (!mcpClient) throw new Error("MCP client is not available");
          return mcpClient.call(server.namespace, tool.name, args);
        };
      }

      // Add a Proxy fallback for uncached tools
      bindings[server.namespace] = new Proxy(serverProxy, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          // Return a function that will attempt the call (lazy connect)
          return async (args?: Record<string, unknown>) => {
            if (signal?.aborted) throw new Error("Execution cancelled");
            if (!mcpClient) throw new Error("MCP client is not available");
            return mcpClient.call(server.namespace, prop, args);
          };
        },
      });
    }
  }

  return bindings;
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function inlineArgsSignature(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") return "args?: Record<string, unknown>";
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (schema.type !== "object" || !properties || typeof properties !== "object") {
    return "args?: Record<string, unknown>";
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const entries = Object.entries(properties as Record<string, Record<string, unknown>>);
  if (entries.length === 0) return "args?: Record<string, unknown>";
  const fields = entries.map(([name, prop]) => {
    const optional = required.includes(name) ? "" : "?";
    return `${name}${optional}: ${simpleSchemaType(prop)};`;
  });
  return `args: { ${fields.join(" ")} }`;
}

function simpleSchemaType(schema: Record<string, unknown>): string {
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return "unknown[]";
  if (schema.type === "object") return "Record<string, unknown>";
  return "unknown";
}

function listServerTools(server: McpServerInfo, offset = 0, limit = 50): string {
  if (server.tools.length === 0) {
    return `codemode.${server.namespace} has no cached tools. Call any tool to trigger a connection.`;
  }

  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const visible = server.tools.slice(safeOffset, safeOffset + safeLimit);
  const start = visible.length > 0 ? safeOffset + 1 : 0;
  const end = safeOffset + visible.length;
  let text = `codemode.${server.namespace} tools ${start}-${end} of ${server.tools.length}`;
  if (visible.length < server.tools.length) {
    text += ` (showing ${visible.length} of ${server.tools.length} tools)`;
  }
  text += ":\n\n";

  for (const t of visible) {
    const callableName = sanitizeToolName(t.name);
    text += `  ${callableName}(${inlineArgsSignature(t.inputSchema)})`;
    if (callableName !== t.name) text += ` (MCP: ${t.name})`;
    if (t.description) {
      const short =
        t.description.length > 120 ? t.description.slice(0, 120) + "..." : t.description;
      text += ` — ${short}`;
    }
    text += "\n";
  }

  if (safeOffset + safeLimit < server.tools.length) {
    text += `\nUse codemode.list_tools({ namespace: "${server.namespace}", offset: ${safeOffset + safeLimit} }) for more.`;
  }

  return text.trimEnd();
}

/**
 * Describe built-in codemode tools.
 */
function describeBuiltinTools(toolName?: string): string {
  const builtins: Record<string, { description: string; params: string }> = {
    read: {
      description:
        "Top-level file tool. Read file contents before editing; use offset/limit for large files.",
      params: "{ path: string; offset?: number; limit?: number }",
    },
    write: {
      description:
        "Top-level file tool. Write an entire file; best for new files or intentional complete rewrites. Avoid full-file rewrites for small localized changes because they risk accidental deletion.",
      params: "{ path: string; content: string }",
    },
    replace_in_file: {
      description:
        "Top-level file tool. Better thought of as replace_in_file: use exact search/replace for precise localized changes. Each oldText must match exactly one unique, non-overlapping region in the original file. Edits are matched against the original file, not sequentially; merge nearby edits into one larger replacement.",
      params: "{ path: string; edits: Array<{ oldText: string; newText: string }> }",
    },
    apply_patch: {
      description:
        "Top-level file tool. Apply a text-only unified diff safely inside the project root. Useful for patch/diff-oriented edits; returns clear hunk failure diagnostics.",
      params: "{ patch: string }",
    },
    search_tools: {
      description:
        "Search for tools by name or description. Returns matching tool names, descriptions, and call signatures.",
      params: "{ query: string }",
    },
    list_mcp_servers: {
      description: "List configured MCP server namespaces available under codemode.*.",
      params: "{}",
    },
    list_tools: {
      description: "List cached tools in an MCP namespace with optional pagination.",
      params: "{ namespace: string; offset?: number; limit?: number }",
    },
    describe_tools: {
      description:
        "Browse available tools. List tools in a namespace, or show full parameters for a specific tool.",
      params: "{ namespace: string; tool?: string }",
    },
    progress: {
      description: "Report progress to the user (streamed to UI in real-time).",
      params: "{ message: string }",
    },
  };

  if (!toolName) {
    // List all built-ins
    let text =
      "codemode (discovery/progress tools; read/write/replace_in_file/apply_patch are top-level file tools):\n\n";
    for (const [name, info] of Object.entries(builtins)) {
      text += `  ${name}(${info.params})\n`;
      text += `    ${info.description}\n\n`;
    }
    return text.trimEnd();
  }

  const tool = builtins[toolName];
  if (!tool) {
    const available = Object.keys(builtins).join(", ");
    return `Unknown tool "${toolName}". Available: ${available}`;
  }

  return `${toolName}(${tool.params})\n${tool.description}`;
}

/**
 * Enrich MCP error with schema information for self-correction.
 */
export function enrichMcpError(server: McpServerInfo, toolName: string, errorText: string): string {
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool?.inputSchema) return errorText;

  return `${errorText}\n\n${generateParamSummary(tool.inputSchema)}`;
}
