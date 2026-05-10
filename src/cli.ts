// cli.ts — Typed command capabilities for codemode.

import { spawn } from "node:child_process";
import { getCommandNames } from "just-bash";
import { executeJustBash, type ShellResult } from "./shell.js";
import type { CliConfig, CliOperationConfig, CliToolConfig } from "./config.js";

export interface CommandResult extends ShellResult {}

type OperationEffect = "read" | "write" | "external";

type OperationHandler = (args: Record<string, unknown>) => string[];

interface OperationDefinition {
  effect: OperationEffect;
  toArgv: OperationHandler;
}

const DEFAULT_GH_ISSUE_VIEW_JSON = [
  "number",
  "title",
  "state",
  "url",
  "body",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
];
const DEFAULT_GH_ISSUE_LIST_JSON = [
  "number",
  "title",
  "state",
  "url",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
];
const DEFAULT_GH_PR_VIEW_JSON = [
  "number",
  "title",
  "state",
  "url",
  "body",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
  "headRefName",
  "baseRefName",
  "isDraft",
  "mergeable",
];
const DEFAULT_GH_PR_LIST_JSON = [
  "number",
  "title",
  "state",
  "url",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
  "headRefName",
  "baseRefName",
  "isDraft",
];

const OPERATIONS: Record<string, Record<string, OperationDefinition>> = {
  git: {
    status: {
      effect: "read",
      toArgv: (args) => [
        "status",
        ...(args.short ? ["--short"] : []),
        ...(args.branch ? ["--branch"] : []),
      ],
    },
    branch: {
      effect: "read",
      toArgv: (args) => ["branch", ...(args.showCurrent ? ["--show-current"] : [])],
    },
  },
  gh: {
    issueView: {
      effect: "external",
      toArgv: (args) => [
        "issue",
        "view",
        requiredNumber(args, "number"),
        ...repo(args),
        ...json(args, DEFAULT_GH_ISSUE_VIEW_JSON),
      ],
    },
    issueList: {
      effect: "external",
      toArgv: (args) => [
        "issue",
        "list",
        ...repo(args),
        ...state(args),
        ...limit(args),
        ...json(args, DEFAULT_GH_ISSUE_LIST_JSON),
      ],
    },
    prView: {
      effect: "external",
      toArgv: (args) => [
        "pr",
        "view",
        requiredNumber(args, "number"),
        ...repo(args),
        ...json(args, DEFAULT_GH_PR_VIEW_JSON),
      ],
    },
    prList: {
      effect: "external",
      toArgv: (args) => [
        "pr",
        "list",
        ...repo(args),
        ...state(args),
        ...limit(args),
        ...json(args, DEFAULT_GH_PR_LIST_JSON),
      ],
    },
  },
  rg: {
    search: {
      effect: "read",
      toArgv: (args) => [
        ...(args.ignoreCase ? ["--ignore-case"] : []),
        ...(args.lineNumber ? ["--line-number"] : []),
        ...(args.hidden ? ["--hidden"] : []),
        ...numberFlag("--max-count", args.maxCount),
        ...stringArrayFlag("--glob", args.glob),
        requiredString(args, "pattern"),
        ...stringArray(args.paths),
      ],
    },
  },
  find: {
    files: {
      effect: "read",
      toArgv: (args) => [
        stringArg(args.path, "."),
        ...numberFlag("-maxdepth", args.maxDepth),
        ...(args.name === undefined ? [] : ["-name", stringArg(args.name, "", "name")]),
        ...findType(args.type),
      ],
    },
  },
  grep: {
    search: {
      effect: "read",
      toArgv: (args) => [
        ...(args.recursive ? ["-R"] : []),
        ...(args.ignoreCase ? ["-i"] : []),
        requiredString(args, "pattern"),
        ...stringArray(args.paths),
      ],
    },
  },
  ls: {
    list: {
      effect: "read",
      toArgv: (args) => [
        ...(args.all ? ["-a"] : []),
        ...(args.long ? ["-l"] : []),
        ...(args.path === undefined ? [] : [stringArg(args.path, ".")]),
      ],
    },
  },
};

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
    const defs = OPERATIONS[toolName];
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
  const definition = OPERATIONS[toolName]?.[operation];
  if (!definition) throw new Error(`Unsupported CLI operation: cli.${toolName}.${operation}`);
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
      resolve({
        stdout: truncateHostOutput(stdout),
        stderr: truncateHostOutput(stderr),
        exitCode: code ?? 0,
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

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}
function requiredNumber(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return String(value);
}
function stringArg(value: unknown, fallback: string, key = "path"): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}
function stringArray(value: unknown, key = "paths"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}
function numberFlag(flag: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${flag} must be an integer`);
  return [flag, String(value)];
}
function stringArrayFlag(flag: string, value: unknown): string[] {
  return stringArray(value, flag).flatMap((v) => [flag, v]);
}
function repo(args: Record<string, unknown>): string[] {
  if (args.repo === undefined) return [];
  if (typeof args.repo !== "string") throw new Error("repo must be a string");
  return ["--repo", args.repo];
}
function json(args: Record<string, unknown>, defaults: string[] = []): string[] {
  if (args.json === undefined && defaults.length === 0) return [];
  const values = args.json === undefined ? defaults : stringArray(args.json, "json");
  if (values.length === 0 || values.some((v) => v.length === 0)) {
    throw new Error("json must be a non-empty array of strings");
  }
  return ["--json", values.join(",")];
}
function state(args: Record<string, unknown>): string[] {
  if (args.state === undefined) return [];
  if (!["open", "closed", "all"].includes(String(args.state))) {
    throw new Error("state must be one of open, closed, all");
  }
  return ["--state", String(args.state)];
}
function limit(args: Record<string, unknown>): string[] {
  if (args.limit === undefined) return [];
  if (
    typeof args.limit !== "number" ||
    !Number.isInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > 1000
  ) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  return ["--limit", String(args.limit)];
}

function findType(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === "file") return ["-type", "f"];
  if (value === "directory") return ["-type", "d"];
  throw new Error("type must be one of file, directory");
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
