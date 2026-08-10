import type { McpTool, McpResource, ServerEntry } from "./types.js";

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}
export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}
export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

export function loadMetadataCache(): MetadataCache | null;
export function saveMetadataCache(cache: MetadataCache): void;
export function computeServerHash(definition: ServerEntry): string;
export function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry): boolean;
export function serializeTools(tools: McpTool[]): CachedTool[];
export function serializeResources(resources: McpResource[]): CachedResource[];
