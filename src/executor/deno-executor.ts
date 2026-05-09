// deno-executor.ts — Deno sandbox executor implementation.
//
// Implements the Cloudflare Executor interface for local Deno execution.
// Manages Deno subprocess, JSON-RPC protocol, and tool call dispatch.

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ToolBindings is used in function signatures via 'bindings' parameter in execute-tool.ts

// Import Cloudflare's types
interface ExecuteResult {
	result: unknown;
	error?: string;
	logs?: string[];
}

interface Executor {
	execute(
		code: string,
		providersOrFns:
			| Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>> }>
			| Record<string, (...args: unknown[]) => Promise<unknown>>
	): Promise<ExecuteResult>;
}

interface DenoExecutorOptions {
	/** Max execution time in ms (default: 120000 = 2 minutes) */
	timeout?: number;
	/** Deno executable path (default: "deno") */
	denoPath?: string;
}

// Protocol types
interface ToolCallMessage {
	type: "tool_call";
	id: number;
	name: string;
	args: unknown;
}

interface ToolResultMessage {
	type: "tool_result";
	id: number;
	result?: unknown;
	error?: string;
}

interface LogMessage {
	type: "log";
	level: "print" | "log" | "warn" | "error";
	args: unknown[];
}

interface DoneMessage {
	type: "done";
	result?: unknown;
	error?: string;
}

type ProtocolMessage = ToolCallMessage | ToolResultMessage | LogMessage | DoneMessage;

/**
 * Deno sandbox executor.
 *
 * Runs generated code in a Deno subprocess with no permissions,
 * communicating via JSON-RPC over stdin/stdout.
 */
export class DenoExecutor implements Executor {
	#timeout: number;
	#denoPath: string;
	#bootstrapPath: string | null = null;

	constructor(options: DenoExecutorOptions = {}) {
		this.#timeout = options.timeout ?? 120_000;
		this.#denoPath = options.denoPath ?? "deno";
	}

	/**
	 * Initialize the executor by writing the bootstrap file.
	 */
	async init(): Promise<void> {
		// Write bootstrap to temp directory
		// In production, this could be bundled with the package
		const tmpDir = await mkdtemp(join(tmpdir(), "pi-codemode-"));
		this.#bootstrapPath = join(tmpDir, "deno-bootstrap.ts");

		// Read the bootstrap source (in production, this would be imported)
		const bootstrapSource = await this.#getBootstrapSource();
		await writeFile(this.#bootstrapPath, bootstrapSource, "utf-8");
	}

	/**
	 * Execute code in the Deno sandbox.
	 */
	async execute(
		code: string,
		providersOrFns:
			| Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>> }>
			| Record<string, (...args: unknown[]) => Promise<unknown>>
	): Promise<ExecuteResult> {
		if (!this.#bootstrapPath) {
			await this.init();
		}

		// Normalize providers to the array format
		const providers = Array.isArray(providersOrFns)
			? providersOrFns
			: [{ name: "codemode", fns: providersOrFns }];

		// Flatten all functions into a single record for lookup
		const allFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
		for (const provider of providers) {
			for (const [name, fn] of Object.entries(provider.fns)) {
				const key = provider.name ? `${provider.name}.${name}` : name;
				allFns[key] = fn;
				// The default codemode provider is exposed both as codemode.foo() and
				// bare host calls from the bootstrap (foo, $, shell).
				if (provider.name === "codemode") {
					allFns[name] = fn;
				}
			}
		}

		// Spawn Deno process
		const config = {
			code,
			strings: {}, // Will be populated from execution context
			timeoutMs: this.#timeout,
		};

		const args = [
			"run",
			"--quiet",
			"--no-prompt",
			// No permissions granted - strict sandbox
			"--allow-read=", // Empty = no read access
			"--allow-write=", // Empty = no write access
			"--allow-net=", // Empty = no network access
			"--allow-env=", // Empty = no env access
			"--allow-run=", // Empty = no subprocess access
			"--allow-sys=", // Empty = no system access
			"--allow-ffi=", // Empty = no FFI access
			this.#bootstrapPath!,
			`--config=${JSON.stringify(config)}`,
		];

		const child = spawn(this.#denoPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		const logs: string[] = [];
		// Handle stdout (protocol messages)
		let stdoutBuffer = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString("utf-8");

			// Parse LSP-style framed messages
			while (true) {
				const headerMatch = stdoutBuffer.match(/Content-Length:\s*(\d+)\r\n\r\n/);
				if (!headerMatch) break;

				const contentLength = parseInt(headerMatch[1], 10);
				const headerEnd = headerMatch.index! + headerMatch[0].length;
				const messageEnd = headerEnd + contentLength;

				if (stdoutBuffer.length < messageEnd) break;

				const json = stdoutBuffer.slice(headerEnd, messageEnd);
				stdoutBuffer = stdoutBuffer.slice(messageEnd);

				try {
					const msg = JSON.parse(json) as ProtocolMessage;
					this.#handleMessage(msg, allFns, logs, child);
				} catch {
					// Invalid JSON - ignore
				}
			}
		});

		// Handle stderr (Deno errors)
		let stderrBuffer = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderrBuffer += data.toString("utf-8");
		});

		// Wait for process to complete
		return new Promise((resolve, reject) => {
			// Timeout handling
			const timeoutId = setTimeout(() => {
				child.kill("SIGTERM");
				resolve({
					result: undefined,
					error: `Execution timed out after ${this.#timeout}ms`,
					logs,
				});
			}, this.#timeout + 5000); // Give 5s grace for cleanup

			child.on("exit", (code) => {
				clearTimeout(timeoutId);

				if (code !== 0 && code !== null) {
					resolve({
						result: undefined,
						error: stderrBuffer || `Deno process exited with code ${code}`,
						logs,
					});
				}
				// Result will have been sent via protocol before exit
			});

			child.on("error", (err) => {
				clearTimeout(timeoutId);
				reject(err);
			});
		});
	}

	/**
	 * Handle a protocol message from the Deno process.
	 */
	#handleMessage(
		msg: ProtocolMessage,
		allFns: Record<string, (...args: unknown[]) => Promise<unknown>>,
		logs: string[],
		child: ReturnType<typeof spawn>
	): void {
		switch (msg.type) {
			case "tool_call": {
				const { id, name, args } = msg;
				const fn = allFns[name];

				if (!fn) {
					// Send error response
					this.#sendToChild(child, {
						type: "tool_result",
						id,
						error: `Tool "${name}" not found`,
					});
					return;
				}

				// Execute the tool asynchronously
				Promise.resolve(fn(args))
					.then((result) => {
						this.#sendToChild(child, { type: "tool_result", id, result });
					})
					.catch((err) => {
						const error = err instanceof Error ? err.message : String(err);
						this.#sendToChild(child, { type: "tool_result", id, error });
					});
				break;
			}

			case "log": {
				const logLine = msg.args
					.map((a) =>
						typeof a === "object" && a !== null
							? JSON.stringify(a)
							: String(a)
					)
					.join(" ");
				logs.push(logLine);
				break;
			}

			case "done": {
				// Execution complete - resolve the promise
				// This is handled by the exit handler, but we could also resolve here
				break;
			}
		}
	}

	/**
	 * Send a message to the Deno child process.
	 */
	#sendToChild(child: ReturnType<typeof spawn>, msg: ProtocolMessage): void {
		const json = JSON.stringify(msg);
		const data = `Content-Length: ${json.length}\r\n\r\n${json}`;
		child.stdin?.write(data);
	}

	/**
	 * Get the bootstrap source code.
	 * In production, this would read from a bundled file.
	 */
	async #getBootstrapSource(): Promise<string> {
		// For now, read from the adjacent file
		// In production, this could be embedded or bundled
		const { readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");

		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);

		try {
			// In built packages, TypeScript emits deno-bootstrap.js next to this file.
			return await readFile(join(__dirname, "deno-bootstrap.js"), "utf-8");
		} catch {
			// In source/test runs, the .ts file may be available.
			return readFile(join(__dirname, "deno-bootstrap.ts"), "utf-8");
		}
	}

	/**
	 * Cleanup resources.
	 */
	async shutdown(): Promise<void> {
		if (this.#bootstrapPath) {
			try {
				await unlink(this.#bootstrapPath);
			} catch {
				// Ignore cleanup errors
			}
			this.#bootstrapPath = null;
		}
	}
}
