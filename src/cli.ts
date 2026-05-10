// cli.ts — Typed command capabilities for codemode.

import { spawn } from "node:child_process";
import { executeJustBash, type ShellResult } from "./shell.js";
import type { CliConfig, CliOperationConfig, CliToolConfig } from "./config.js";

export interface CommandResult extends ShellResult {}

type OperationHandler = (args: Record<string, unknown>) => string[];

const OPERATIONS: Record<string, Record<string, OperationHandler>> = {
  git: {
    status: (args) => [
      "status",
      ...(args.short ? ["--short"] : []),
      ...(args.branch ? ["--branch"] : []),
    ],
    branch: (args) => ["branch", ...(args.showCurrent ? ["--show-current"] : [])],
  },
  gh: {
    issueView: (args) => [
      "issue",
      "view",
      requiredNumber(args, "number"),
      ...repo(args),
      ...json(args),
    ],
    issueList: (args) => ["issue", "list", ...repo(args), ...state(args), ...limit(args)],
    prView: (args) => ["pr", "view", requiredNumber(args, "number"), ...repo(args), ...json(args)],
    prList: (args) => ["pr", "list", ...repo(args), ...state(args), ...limit(args)],
  },
  rg: {
    search: (args) => [
      ...(args.ignoreCase ? ["--ignore-case"] : []),
      ...(args.lineNumber ? ["--line-number"] : []),
      ...(args.hidden ? ["--hidden"] : []),
      ...numberFlag("--max-count", args.maxCount),
      ...stringArrayFlag("--glob", args.glob),
      requiredString(args, "pattern"),
      ...stringArray(args.paths),
    ],
  },
  find: {
    files: (args) => [
      stringArg(args.path, "."),
      ...numberFlag("-maxdepth", args.maxDepth),
      ...(typeof args.name === "string" ? ["-name", args.name] : []),
      ...(args.type === "file" ? ["-type", "f"] : args.type === "directory" ? ["-type", "d"] : []),
    ],
  },
  grep: {
    search: (args) => [
      ...(args.recursive ? ["-R"] : []),
      ...(args.ignoreCase ? ["-i"] : []),
      requiredString(args, "pattern"),
      ...stringArray(args.paths),
    ],
  },
  ls: {
    list: (args) => [
      ...(args.all ? ["-a"] : []),
      ...(args.long ? ["-l"] : []),
      ...(typeof args.path === "string" ? [args.path] : []),
    ],
  },
};

export function createCliBindings(
  config: CliConfig | undefined,
  projectRoot: string,
  signal?: AbortSignal,
) {
  const cli: Record<string, unknown> = {};
  for (const [toolName, toolConfig] of Object.entries(config ?? {})) {
    const defs = OPERATIONS[toolName];
    if (!defs) continue;
    const tool: Record<string, (args?: Record<string, unknown>) => Promise<CommandResult>> = {};
    for (const operation of configuredOperations(toolConfig)) {
      const handler = defs[operation];
      if (!handler) continue;
      tool[operation] = async (args = {}) => {
        if (signal?.aborted) throw new Error("Execution cancelled");
        const argv = handler(args);
        if (toolConfig.backend === "host") {
          return executeHost(
            toolName,
            argv,
            projectRoot,
            operationConfig(toolConfig, operation).timeoutMs,
            signal,
          );
        }
        return executeJustBash(projectRoot, quoteCommand([toolName, ...argv]), {
          timeoutMs: operationConfig(toolConfig, operation).timeoutMs,
        });
      };
    }
    cli[toolName] = tool;
  }
  return cli;
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
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "" }, signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function quoteCommand(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}

function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string") throw new Error(`${key} is required`);
  return args[key];
}
function requiredNumber(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "number") throw new Error(`${key} is required`);
  return String(args[key]);
}
function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function numberFlag(flag: string, value: unknown): string[] {
  return typeof value === "number" ? [flag, String(value)] : [];
}
function stringArrayFlag(flag: string, value: unknown): string[] {
  return stringArray(value).flatMap((v) => [flag, v]);
}
function repo(args: Record<string, unknown>): string[] {
  return typeof args.repo === "string" ? ["--repo", args.repo] : [];
}
function json(args: Record<string, unknown>): string[] {
  return Array.isArray(args.json) ? ["--json", stringArray(args.json).join(",")] : [];
}
function state(args: Record<string, unknown>): string[] {
  return typeof args.state === "string" ? ["--state", args.state] : [];
}
function limit(args: Record<string, unknown>): string[] {
  return typeof args.limit === "number" ? ["--limit", String(args.limit)] : [];
}
