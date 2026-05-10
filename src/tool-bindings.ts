// tool-bindings.ts — Create runtime bindings that back the TypeScript type declarations.
//
// Each binding wraps a real Pi tool implementation and returns simplified values.
// MCP tools are exposed as nested namespaces (e.g., codemode.github.search_issues).

import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { searchTools } from "./search.js";
import { executeJustBash } from "./shell.js";
import { generateToolSignature, generateParamSummary } from "./type-generator.js";
import { createFileTools } from "./file-tools.js";
import type { McpClient } from "./mcp-client.js";
import type { McpServerInfo } from "./search.js";

/** The shape the sandbox code sees at runtime */
export interface ToolBindings {
  read(params: { path: string; offset?: number; limit?: number }): Promise<string>;
  write(params: { path: string; content: string }): Promise<void>;
  edit(params: {
    path: string;
    edits: Array<{ oldText: string; newText: string }>;
  }): Promise<string>;
  search_tools(params: { query: string }): Promise<string>;
  describe_tools(params: { namespace: string; tool?: string }): Promise<string>;
  $(params: {
    parts: string[];
    values: unknown[];
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  shell(params: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
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

    async edit(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      return fileTools.edit(params);
    },

    async search_tools(params) {
      return searchTools(params.query);
    },

    async $(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      let command = "";
      for (let i = 0; i < params.parts.length; i++) {
        command += params.parts[i];
        if (i < params.values.length) {
          const value = params.values[i];
          if (typeof value === "string") {
            command += "'" + value.replace(/'/g, "'\\''") + "'";
          } else {
            command += String(value);
          }
        }
      }
      return executeJustBash(cwd, command.trim());
    },

    async shell(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      let command = params.command;
      if (params.cwd && params.cwd !== "/workspace") {
        command = `cd '${params.cwd.replace(/'/g, "'\\''")}' && ${command}`;
      }
      return executeJustBash(cwd, command, { timeoutMs: params.timeoutMs });
    },

    async describe_tools(params) {
      // Handle built-in tools
      if (params.namespace === "codemode") {
        return describeBuiltinTools(params.tool);
      }

      // Handle MCP servers
      if (!mcpServers || mcpServers.length === 0) {
        return "No MCP servers available.";
      }

      const server = mcpServers.find((s) => s.namespace === params.namespace);
      if (!server) {
        const available = mcpServers.map((s) => s.namespace).join(", ");
        return `Unknown namespace "${params.namespace}". Available: ${available || "none"}`;
      }

      if (!params.tool) {
        // List all tools in this namespace
        if (server.tools.length === 0) {
          return `codemode.${server.namespace} has no cached tools. Call any tool to trigger a connection.`;
        }
        let text = `codemode.${server.namespace} — ${server.tools.length} tools:\n\n`;
        for (const t of server.tools) {
          text += `  ${t.name}`;
          if (t.description) {
            const short =
              t.description.length > 120 ? t.description.slice(0, 120) + "..." : t.description;
            text += ` — ${short}`;
          }
          text += "\n";
        }
        return text.trimEnd();
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

/**
 * Describe built-in codemode tools.
 */
function describeBuiltinTools(toolName?: string): string {
  const builtins: Record<string, { description: string; params: string }> = {
    search_tools: {
      description:
        "Search for tools by name or description. Returns matching tool names, descriptions, and call signatures.",
      params: "{ query: string }",
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
    let text = "codemode (discovery/progress tools; file tools are top-level read/write/edit):\n\n";
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
