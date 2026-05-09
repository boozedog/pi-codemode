// search.ts — Full-text search over Pi tools and MCP tools using MiniSearch.
//
// Indexes tool names, descriptions, server namespaces, and parameter info.
// Supports fuzzy matching, prefix search, and BM25 ranking.

import MiniSearch from "minisearch";

export interface SearchDoc {
	/** Unique ID: "pi:toolName" or "mcp:namespace:toolName" */
	id: string;
	/** Tool name */
	name: string;
	/** Human-readable description */
	description: string;
	/** "pi" or MCP server namespace */
	source: string;
	/** How to call it: "codemode.read({ path })" or "codemode.github.search_issues({ ... })" */
	callSig: string;
	/** Parameter names joined (for matching on param names) */
	params: string;
}

export interface ToolInfo {
	name: string;
	description?: string;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpServerInfo {
	serverName: string;
	namespace: string;
	tools: McpToolInfo[];
}

let index: MiniSearch<SearchDoc> | null = null;
let docs: SearchDoc[] = [];

/**
 * Build/rebuild the search index from Pi tools and MCP tools.
 */
export function buildSearchIndex(
	piTools: ToolInfo[],
	mcpServers?: McpServerInfo[]
): void {
	docs = [];

	// Index Pi tools (using codemode.* namespace)
	for (const tool of piTools) {
		// Skip execute_tools itself (that's what the user is already using)
		if (tool.name === "execute_tools") continue;
		docs.push({
			id: `pi:${tool.name}`,
			name: tool.name,
			description: tool.description ?? "",
			source: "pi",
			callSig: `codemode.${tool.name}()`,
			params: "",
		});
	}

	// Index MCP tools from all servers
	if (mcpServers) {
		for (const server of mcpServers) {
			for (const tool of server.tools) {
				// Extract param names from inputSchema for searchability
				const paramNames = extractParamNames(tool.inputSchema);
				docs.push({
					id: `mcp:${server.namespace}:${tool.name}`,
					name: tool.name,
					description: tool.description ?? "",
					source: server.namespace,
					callSig: `codemode.${server.namespace}.${tool.name}()`,
					params: paramNames.join(" "),
				});
			}
		}
	}

	// Create index
	index = new MiniSearch<SearchDoc>({
		fields: ["name", "description", "source", "params"],
		storeFields: ["name", "description", "source", "callSig"],
		searchOptions: {
			boost: { name: 3, source: 2, description: 1, params: 0.5 },
			fuzzy: 0.2,
			prefix: true,
		},
	});

	index.addAll(docs);
}

/**
 * Search for tools matching a query.
 * Returns formatted results with call signatures.
 */
export function searchTools(query: string, maxResults: number = 25): string {
	if (!index || docs.length === 0) {
		return "Search index not built yet. No tools available.";
	}

	const trimmed = query.trim();
	if (!trimmed) return "Empty search query.";

	const results = index.search(trimmed, {
		boost: { name: 3, source: 2, description: 1, params: 0.5 },
		fuzzy: 0.2,
		prefix: true,
		combineWith: "OR",
	});

	if (results.length === 0) {
		return `No tools matching "${query}".`;
	}

	const top = results.slice(0, maxResults);
	let text = `Found ${results.length} tool${results.length === 1 ? "" : "s"} matching "${query}"`;
	if (results.length > maxResults) {
		text += ` (showing top ${maxResults})`;
	}
	text += ":\n\n";

	for (const r of top) {
		text += `[${r.source}] ${r.callSig}\n`;
		if (r.description) {
			// Truncate long descriptions
			const desc = r.description.length > 200
				? r.description.slice(0, 200) + "..."
				: r.description;
			text += `  ${desc}\n`;
		}
		text += "\n";
	}

	return text.trim();
}

function extractParamNames(inputSchema: unknown): string[] {
	if (!inputSchema || typeof inputSchema !== "object") return [];
	const s = inputSchema as Record<string, unknown>;
	if (s.type === "object" && s.properties && typeof s.properties === "object") {
		return Object.keys(s.properties as Record<string, unknown>);
	}
	return [];
}
