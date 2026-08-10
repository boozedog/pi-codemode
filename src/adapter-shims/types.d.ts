// Local type shims for pi-mcp-adapter subpath imports.
//
// pi-mcp-adapter ships raw .ts sources with no stable public entrypoint. Importing
// its subpaths directly makes TypeScript follow the whole import graph into
// adapter internals (and newer @earendil-works references), which breaks the build
// on some adapter versions. These shims type only the surface we use, and are
// wired via tsconfig "paths" so TypeScript never resolves into the adapter's
// source internals. Runtime still resolves to the real adapter package.

export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; text?: string; blob?: string };
  uri?: string;
  name?: string;
  description?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  settings?: { toolPrefix?: "server" | "none" | "short" };
}
