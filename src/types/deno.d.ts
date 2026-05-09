// Stub type declarations for Deno global
// This file runs inside Deno subprocess, but we need types for compilation.

declare global {
	// Minimal Deno namespace for bootstrap compilation
	const Deno: {
		// Basic I/O
		stdin: {
			readable: ReadableStream<Uint8Array>;
		};
		stdout: {
			writeSync(data: Uint8Array): void;
		};

		// Process
		args: string[];
		exit(code?: number): void;

		// Permissions (used in our bootstrap)
		permissions: {
			query(options: { name: string }): Promise<{ state: "granted" | "denied" | "prompt" }>;
		};

		// File system (if needed later)
		readFile(path: string | URL): Promise<Uint8Array>;
		readTextFile(path: string | URL): Promise<string>;
	};
}

export {};
