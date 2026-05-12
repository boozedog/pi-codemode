// cli.ts — Typed command capabilities for codemode.

import { spawn } from "node:child_process";
import { getCommandNames } from "just-bash";
import { executeJustBash, type ShellResult } from "./shell.js";
import type { CliConfig, CliOperationConfig, CliToolConfig } from "./config.js";
import { CLI_OPERATIONS, getCliOperationDefinition } from "./cli-operations.js";

export interface CommandResult extends ShellResult {
  json?: unknown;
}

export function createCliBindings(
  config: CliConfig | undefined,
  projectRoot: string,
  signal?: AbortSignal,
) {
  validateCliConfig(config);
  return {
    __call: async (params: { tool?: unknown; operation?: unknown; args?: unknown }) => {
      if (signal?.aborted) throw new Error("Execution cancelled");
      if (typeof params.tool !== "string" || typeof params.operation !== "string") {
        throw new Error("CLI dispatcher requires string tool and operation");
      }
      return executeCliOperation(
        config,
        projectRoot,
        params.tool,
        params.operation,
        params.args,
        signal,
      );
    },
  };
}

function validateCliConfig(config: CliConfig | undefined): void {
  for (const [toolName, toolConfig] of Object.entries(config ?? {})) {
    const defs = CLI_OPERATIONS[toolName];
    if (!defs) continue;
    for (const operation of configuredOperations(toolConfig)) {
      const definition = defs[operation];
      if (!definition) continue;
      if (toolConfig.backend === "just-bash" && definition.effect !== "read") {
        throw new Error(
          `Operation cli.${toolName}.${operation} cannot use just-bash backend because it is not read-only`,
        );
      }
      if (toolConfig.backend === "just-bash" && !listJustBashCommands().includes(toolName)) {
        throw new Error(`just-bash command is not available: ${toolName}`);
      }
    }
  }
}

async function executeCliOperation(
  config: CliConfig | undefined,
  projectRoot: string,
  toolName: string,
  operation: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const toolConfig = config?.[toolName];
  if (!toolConfig || !configuredOperations(toolConfig).includes(operation)) {
    throw new Error(`CLI operation is not configured: cli.${toolName}.${operation}`);
  }
  const argv = buildCliArgv(toolName, operation, asArgs(args));
  const opConfig = operationConfig(toolConfig, operation);
  if (toolConfig.backend === "host") {
    return executeHost(
      toolConfig.command ?? toolName,
      argv,
      projectRoot,
      toolName,
      operation,
      opConfig.timeoutMs,
      signal,
    );
  }
  return executeJustBash(projectRoot, quoteCommand([toolName, ...argv]), {
    timeoutMs: opConfig.timeoutMs,
  });
}

export function buildCliArgv(
  toolName: string,
  operation: string,
  args: Record<string, unknown> = {},
): string[] {
  const definition = getCliOperationDefinition(toolName, operation);
  if (!definition) throw new Error(`Unsupported CLI operation: cli.${toolName}.${operation}`);
  validateArgs(definition.inputSchema, args);
  return definition.toArgv(args);
}

export function listJustBashCommands(): string[] {
  return getCommandNames();
}

export function configuredOperations(toolConfig: CliToolConfig): string[] {
  return Array.isArray(toolConfig.operations)
    ? toolConfig.operations
    : Object.keys(toolConfig.operations ?? {});
}

function operationConfig(toolConfig: CliToolConfig, operation: string): CliOperationConfig {
  if (!toolConfig.operations || Array.isArray(toolConfig.operations)) return {};
  return toolConfig.operations[operation] ?? {};
}

function executeHost(
  command: string,
  args: string[],
  cwd: string,
  toolName: string,
  operation: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: hostCommandEnv(), signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`CLI operation timed out after ${timeoutMs}ms: cli.${toolName}.${operation}`),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`CLI executable not found for cli.${toolName}.${operation}: ${command}`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const truncatedStdout = truncateHostOutput(stdout);
      resolve({
        stdout: truncatedStdout,
        stderr: truncateHostOutput(stderr),
        exitCode: code ?? 0,
        ...parsedJsonOutput(truncatedStdout),
      });
    });
  });
}

function hostCommandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_HOST: process.env.GITHUB_HOST,
  };
}

function quoteCommand(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}

const HOST_MAX_OUTPUT_BYTES = 50 * 1024;

function asArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new Error("CLI args must be an object");
  return args as Record<string, unknown>;
}

function validateArgs(
  schema: { required?: string[]; properties?: Record<string, unknown> },
  args: Record<string, unknown>,
): void {
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`${key} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!prop) throw new Error(`Unknown CLI argument: ${key}`);
    if (value === undefined) continue;
    if (prop.enum && !prop.enum.includes(value))
      throw new Error(`${key} must be one of ${prop.enum.join(", ")}`);
    if (prop.type === "string" && typeof value !== "string")
      throw new Error(`${key} must be a string`);
    if (prop.type === "boolean" && typeof value !== "boolean")
      throw new Error(`${key} must be a boolean`);
    if (prop.type === "integer" && (typeof value !== "number" || !Number.isInteger(value)))
      throw new Error(`${key} must be an integer`);
    if (
      prop.type === "array" &&
      (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    )
      throw new Error(`${key} must be an array of strings`);
  }
}

function appendBounded(current: string, chunk: string): string {
  const max = HOST_MAX_OUTPUT_BYTES + 1;
  const next = current + chunk;
  return next.length > max ? next.slice(-max) : next;
}

function truncateHostOutput(output: string): string {
  if (output.length <= HOST_MAX_OUTPUT_BYTES) return output;
  return `${output.slice(-HOST_MAX_OUTPUT_BYTES)}\n[Output truncated, showing last 50 KiB.]`;
}

function parsedJsonOutput(stdout: string): { json?: unknown } {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.includes("[Output truncated")) return {};
  try {
    return { json: JSON.parse(trimmed) as unknown };
  } catch {
    return {};
  }
}
