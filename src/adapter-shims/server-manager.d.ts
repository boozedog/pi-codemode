import type { McpContent, McpTool, McpResource, ServerEntry } from "./types.js";

export interface ServerConnection {
  client: {
    callTool(args: {
      name: string;
      arguments: unknown;
    }): Promise<{ content?: McpContent[]; isError?: boolean }>;
  };
  tools: McpTool[];
  resources: McpResource[];
  status: "connected" | "closed" | "needs-auth";
}

export class McpServerManager {
  connect(name: string, definition: ServerEntry): Promise<ServerConnection>;
  getConnection(name: string): ServerConnection | undefined;
  touch(name: string): void;
  incrementInFlight(name: string): void;
  decrementInFlight(name: string): void;
  closeAll(): Promise<void>;
}
