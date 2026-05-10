// type-generator.ts — Generate TypeScript type definitions for the tool API.
//
// Uses Cloudflare's generateTypesFromJsonSchema for JSON Schema → TypeScript.
// Generates:
// 1. Built-in tool types (read, write, edit, search_tools, etc.)
// 2. MCP server types with nested namespaces
// 3. System prompt summary (compact, not full types)

import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import type { McpServerInfo } from "./search.js";
import { generateShellTypeDefs } from "./shell.js";

// Top-level file tool descriptors mirror Pi's native tool names and schemas.
const fileToolDescriptors: Record<string, { description?: string; inputSchema: JSONSchema7 }> = {
  read: {
    description:
      "Read a file and return its content as a string. Each line is prefixed with line number and hash for reference. Default limit: 2000 lines or 50KB.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative or absolute)",
        },
        offset: {
          type: "number",
          description: "Line number to start from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Maximum lines to read",
        },
      },
      required: ["path"],
    },
  },
  write: {
    description:
      "Write content to a file. Creates parent directories automatically. Overwrites the file if it already exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative or absolute)",
        },
        content: {
          type: "string",
          description: "Content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  edit: {
    description:
      "Edit a file using Pi's exact replacement semantics. Each oldText must match exactly one unique, non-overlapping region in the original file. Nearby edits should be merged into one edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative or absolute)",
        },
        edits: {
          type: "array",
          description:
            "Exact text replacements. Each oldText must match exactly once in the original file; edits must not overlap.",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Exact literal original text to replace; must match exactly once",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
};

// Built-in codemode namespace descriptors using JSON Schema (for Cloudflare type generation)
const builtinToolDescriptors: Record<string, { description?: string; inputSchema: JSONSchema7 }> = {
  search_tools: {
    description:
      "Search for tools by name or description. Returns matching tool names, descriptions, and call signatures.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches tool names, descriptions, and parameter names",
        },
      },
      required: ["query"],
    },
  },
  list_mcp_servers: {
    description: "List configured MCP server namespaces available under codemode.*.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  list_tools: {
    description: "List cached tools in an MCP namespace with optional pagination.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "MCP server namespace (e.g. 'github', 'slack')",
        },
        offset: {
          type: "number",
          description: "Zero-based offset for large tool lists",
        },
        limit: {
          type: "number",
          description: "Maximum tools to return (default 50, max 100)",
        },
      },
      required: ["namespace"],
    },
  },
  describe_tools: {
    description:
      "Browse available tools. List tools in a namespace, or show full parameters for a specific tool.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "MCP server namespace (e.g. 'github', 'slack') or 'codemode' for built-ins",
        },
        tool: {
          type: "string",
          description:
            "Tool name to get full parameter details. Omit to list all tools in the namespace.",
        },
      },
      required: ["namespace"],
    },
  },
  progress: {
    description: "Report progress to the user (streamed to UI in real-time).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Progress message to display" },
      },
      required: ["message"],
    },
  },
};

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function generateTypesFromJsonSchema(
  descriptors: Record<string, { description?: string; inputSchema: JSONSchema7 }>,
): string {
  return Object.entries(descriptors)
    .map(([name, descriptor]) => {
      const schema = descriptor.inputSchema;
      const argsType = schemaToType(schema, schema.required ?? []);
      const doc = descriptor.description
        ? `/** ${descriptor.description.replace(/\*\//g, "* /").replace(/\n/g, " ")} */\n`
        : "";
      return `${doc}${sanitizeToolName(name)}(args: ${argsType})`;
    })
    .join("\n");
}

function schemaToType(schema: JSONSchema7Definition | undefined, required: string[] = []): string {
  if (!schema || typeof schema === "boolean") return "any";

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaToType({ ...schema, type }, required)).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${schemaToType(schema.items as JSONSchema7Definition | undefined)}>`;
    case "object": {
      const properties = schema.properties ?? {};
      const entries = Object.entries(properties);
      if (entries.length === 0) return "Record<string, unknown>";
      const fields = entries.map(([propName, propSchema]) => {
        const optional = required.includes(propName) ? "" : "?";
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propName)
          ? propName
          : JSON.stringify(propName);
        return `${key}${optional}: ${schemaToType(propSchema)};`;
      });
      return `{ ${fields.join(" ")} }`;
    }
    default:
      return "any";
  }
}

/**
 * Generate the type definition string for built-in tools.
 */
export function generateBuiltinTypeDefs(): string {
  // Generate types from JSON Schema descriptors
  void fileToolDescriptors;
  const generated = generateTypesFromJsonSchema(builtinToolDescriptors);

  // Wrap in the expected interface structure
  return `\
/** Tool API available inside execute_tools code blocks. */

declare function read(args: { path: string; offset?: number; limit?: number }): Promise<string>;
declare function write(args: { path: string; content: string }): Promise<void>;
declare function edit(args: {
  path: string;
  edits: Array<{
    /** Exact literal original text. Must match exactly once in the original file. */
    oldText: string;
    /** Replacement text. */
    newText: string;
  }>;
}): Promise<string>;

declare const codemode: CodemodeTools & McpServerNamespaces;

interface McpServerNamespaces {}

interface CodemodeTools {
${generated
  .split("\n")
  .map((line) => {
    if (!line) return line;
    const trimmed = line.trim();
    if (trimmed.startsWith("/**")) return "  " + line;
    return "  " + trimmed + ": Promise<string>;";
  })
  .join("\n")}
}

/** Print output to include in the result returned to you. */
declare function print(...args: any[]): void;

/** Named string constants passed via the 'strings' parameter. Use for file content that's hard to quote in JS. */
declare const π: Readonly<Record<string, string>>;

${generateShellTypeDefs()}
`;
}

/**
 * Generate full TypeScript declarations for MCP server namespaces.
 * Used by the TYPE CHECKER — includes all tool signatures from inputSchema.
 */
export function generateMcpServerTypeDefs(servers: McpServerInfo[]): string {
  if (servers.length === 0) {
    return `/** No MCP servers are configured. */
interface McpServerNamespaces {}
`;
  }

  const parts: string[] = [];

  // Generate the McpServerNamespaces interface
  parts.push(`interface McpServerNamespaces {`);
  for (const server of servers) {
    parts.push(`  /** MCP server: ${server.serverName} (${server.tools.length} tools) */`);
    parts.push(
      `  ${sanitizeIdentifier(server.namespace)}: ${serverInterfaceName(server.namespace)};`,
    );
  }
  parts.push(`}`);
  parts.push(``);

  // Generate each server's interface with typed tool methods
  for (const server of servers) {
    const ifaceName = serverInterfaceName(server.namespace);
    parts.push(`interface ${ifaceName} {`);

    // Convert tools to JSON Schema descriptors for Cloudflare generator
    const toolDescriptors: Record<string, { description?: string; inputSchema: JSONSchema7 }> = {};

    for (const tool of server.tools) {
      toolDescriptors[tool.name] = {
        description: tool.description,
        inputSchema: (tool.inputSchema as JSONSchema7) || { type: "object" },
      };
    }

    // Generate types for all tools in this server
    const serverTypes = generateTypesFromJsonSchema(toolDescriptors);

    // Parse and format the generated types
    const lines = serverTypes.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      // Add JSDoc if present in the original tool
      const toolName = line.match(/^(\w+)\s*\(/)?.[1];
      if (toolName) {
        const tool = server.tools.find((t) => sanitizeToolName(t.name) === toolName);
        if (tool?.description) {
          const desc = tool.description.replace(/\*\//g, "* /").replace(/\n/g, " ");
          parts.push(`  /** ${desc} */`);
        }
      }
      // Add Promise<string> return type and proper indentation
      if (line.includes("(args")) {
        parts.push(`  ${line.trim()}: Promise<string>;`);
      } else {
        parts.push(`  ${line}`);
      }
    }

    parts.push(`}`);
    parts.push(``);
  }

  return parts.join("\n");
}

/**
 * Generate a compact MCP server summary for the system prompt.
 * Lists server namespaces only — the LLM uses describe_tools() for details.
 */
export function generateMcpSummaryForPrompt(servers: McpServerInfo[]): string {
  if (servers.length === 0) return "";

  const lines: string[] = [];
  lines.push(`### MCP Servers`);
  lines.push(``);
  lines.push(`The following MCP servers are available as typed namespaces on \`codemode\`.`);
  lines.push(
    `Use \`codemode.describe_tools({ namespace: "..." })\` to browse tools and see their parameters.`,
  );
  lines.push(`Use \`codemode.search_tools({ query: "..." })\` to find tools by keyword.`);
  lines.push(``);

  for (const server of servers) {
    const count = server.tools.length;
    if (count === 0) {
      lines.push(
        `- **codemode.${sanitizeIdentifier(server.namespace)}** — ${server.serverName} (connect on first call)`,
      );
    } else {
      lines.push(
        `- **codemode.${sanitizeIdentifier(server.namespace)}** — ${server.serverName} (${count} tools)`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Generate a TypeScript call signature for a single MCP tool.
 * Used by describe_tools and MCP error messages.
 */
export function generateToolSignature(
  namespace: string,
  toolName: string,
  description: string | undefined,
  inputSchema: unknown,
): string {
  const lines: string[] = [];
  if (description) {
    lines.push(`/** ${description.replace(/\*\//g, "* /").replace(/\n/g, " ")} */`);
  }

  // Use Cloudflare to generate just this tool's signature
  const descriptor = {
    [toolName]: {
      description,
      inputSchema: (inputSchema as JSONSchema7) || { type: "object" },
    },
  };
  const generated = generateTypesFromJsonSchema(descriptor);
  const sig = generated.split("\n")[0]?.trim() || `${sanitizeToolName(toolName)}(args: any)`;

  lines.push(`codemode.${namespace}.${sig}: Promise<string>`);
  return lines.join("\n");
}

/**
 * Generate a compact parameter summary for MCP error messages.
 */
export function generateParamSummary(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") {
    return "No parameters defined.";
  }
  const s = inputSchema as Record<string, unknown>;
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return "No parameters defined.";
  }
  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const entries = Object.entries(props);
  if (entries.length === 0) return "No parameters defined.";

  const lines: string[] = ["Parameters:"];
  for (const [name, prop] of entries) {
    const isReq = required.includes(name);
    const typeStr = jsonSchemaToSimpleType(prop);
    let line = `  ${name}${isReq ? " (required)" : ""}: ${typeStr}`;
    if (prop.description) {
      line += ` — ${String(prop.description).replace(/\n/g, " ")}`;
    }
    if (prop.enum && Array.isArray(prop.enum)) {
      line += ` [values: ${prop.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}]`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function serverInterfaceName(namespace: string): string {
  const pascal = namespace
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return `Mcp${pascal}Tools`;
}

function sanitizeIdentifier(name: string): string {
  return sanitizeToolName(name).replace(/[^a-zA-Z0-9_$]/g, "_");
}

/**
 * Convert a JSON Schema to a simple type string for error messages.
 */
function jsonSchemaToSimpleType(schema: Record<string, unknown>): string {
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown>;
    return items ? `${jsonSchemaToSimpleType(items)}[]` : "any[]";
  }
  if (schema.type === "object") return "object";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  return "any";
}
