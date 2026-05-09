// Stub type declarations for Pi Coding Agent API
// These are provided by the host at runtime; we declare minimal shapes for compilation.

declare module "@mariozechner/pi-coding-agent" {
	export interface ExtensionAPI {
		registerFlag(name: string, options: FlagOptions): void;
		registerCommand(name: string, options: CommandOptions): void;
		registerTool(tool: ToolDefinition): void;
		getFlag(name: string): boolean | string | number | undefined;
		getActiveTools(): string[];
		getAllTools(): ToolInfo[];
		setActiveTools(tools: string[]): void;
		on(event: string, handler: EventHandler): void;
	}

	export interface FlagOptions {
		description: string;
		type: "boolean" | "string" | "number";
		default?: boolean | string | number;
	}

	export interface CommandOptions {
		description: string;
		handler: (args: string[], ctx: ExtensionContext) => Promise<void>;
	}

	export interface ToolDefinition {
		name: string;
		label?: string;
		description: string;
		parameters: unknown; // TypeBox schema
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext
		) => Promise<ToolResult>;
		renderCall?: (args: unknown, theme: unknown) => unknown;
		renderResult?: (result: unknown, options: unknown, theme: unknown) => unknown;
	}

	export interface ToolInfo {
		name: string;
		description?: string;
	}

	export interface ToolResult {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
		details?: unknown;
	}

	export interface ExtensionContext {
		ui: {
			notify(message: string, type: "info" | "warning" | "error" | "success"): void;
		};
	}

	type EventHandler = (event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<void | { systemPrompt?: string }>;
}

declare module "@mariozechner/pi-agent-core" {
	// Re-export for compatibility
	export type AgentToolUpdateCallback = (update: { content: Array<{ type: string; text: string }>; details?: unknown }) => void;
}
