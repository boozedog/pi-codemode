// cli.ts — Typed command capabilities for codemode.

import { spawn } from "node:child_process";
import Ajv from "ajv";
import type { JSONSchema7 } from "json-schema";
import type { CliConfig, CliOperationConfig, CliToolConfig } from "./config.js";
import { getCliOperationDefinition } from "./cli-operations.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutFile?: string;
  stderrFile?: string;
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
    if (toolConfig.backend !== "host") {
      throw new Error(
        `Unsupported CLI backend '${String(toolConfig.backend)}' for cli.${toolName}. Only 'host' is supported`,
      );
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
  const safeArgs = asArgs(args);
  const opConfig = operationConfig(toolConfig, operation);
  if (toolName === "gh" && isIssueBlockedByMutation(operation)) {
    return executeGhIssueBlockedByMutation(
      toolConfig.command ?? toolName,
      projectRoot,
      operation,
      safeArgs,
      opConfig.timeoutMs,
      signal,
    );
  }
  const argv = buildCliArgv(toolName, operation, safeArgs);
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

function isIssueBlockedByMutation(operation: string): boolean {
  return operation === "issueAddBlockedBy" || operation === "issueRemoveBlockedBy";
}

async function executeGhIssueBlockedByMutation(
  command: string,
  cwd: string,
  operation: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  validateArgs(getCliOperationDefinition("gh", operation)!.inputSchema, args);
  const blockingNumber = requiredIntegerArg(args, "blockingNumber");
  const issueResult = await executeHost(
    command,
    ["api", ...repoApiIssuePath(args.repo, blockingNumber), "--jq", ".id"],
    cwd,
    "gh",
    operation,
    timeoutMs,
    signal,
  );
  if (issueResult.exitCode !== 0) return issueResult;
  const issueId = issueResult.stdout.trim();
  if (!/^\d+$/.test(issueId)) {
    throw new Error(`Could not resolve REST database id for issue #${blockingNumber}`);
  }
  const number = requiredIntegerArg(args, "number");
  const endpoint = [
    "api",
    ...repoApiDependencyPath(
      args.repo,
      number,
      operation === "issueRemoveBlockedBy" ? issueId : undefined,
    ),
  ];
  const argv =
    operation === "issueAddBlockedBy"
      ? [...endpoint, "--method", "POST", "--field", `issue_id=${issueId}`]
      : [...endpoint, "--method", "DELETE"];
  return executeHost(command, argv, cwd, "gh", operation, timeoutMs, signal);
}

function requiredIntegerArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function repoApiIssuePath(repo: unknown, issueNumber: number): string[] {
  return [`${repoApiPath(repo)}/issues/${issueNumber}`];
}

function repoApiDependencyPath(repo: unknown, issueNumber: number, issueId?: string): string[] {
  return [
    `${repoApiPath(repo)}/issues/${issueNumber}/dependencies/blocked_by${issueId ? `/${issueId}` : ""}`,
  ];
}

function repoApiPath(repo: unknown): string {
  if (repo === undefined) return "repos/{owner}/{repo}";
  if (typeof repo !== "string") throw new Error("repo must be a string");
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error("repo must be in OWNER/REPO format");
  return `repos/${repo}`;
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
    const child = spawn(command, args, { cwd, env: hostCommandEnv(toolName), signal });
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

function hostCommandEnv(toolName: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  if (toolName === "gh") {
    env.GH_TOKEN = process.env.GH_TOKEN;
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    env.GITHUB_HOST = process.env.GITHUB_HOST;
  }
  return env;
}

const HOST_MAX_OUTPUT_BYTES = 50 * 1024;

function asArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new Error("CLI args must be an object");
  return args as Record<string, unknown>;
}

const ajv = new Ajv({ allErrors: false, strict: false });

/** Minimal shape of an Ajv validation error used for message formatting. */
interface ValidationError {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/**
 * Validate CLI operation arguments against their JSON-Schema input schema.
 * Rejects unknown, object, and any other property type that the bespoke
 * validator previously allowed through silently.
 */
export function validateArgs(schema: JSONSchema7, args: Record<string, unknown>): void {
  const validate = ajv.compile(schema);
  if (validate(args)) return;
  const error = validate.errors?.[0] as ValidationError | undefined;
  throw new Error(error ? formatValidationError(error) : "Invalid CLI arguments");
}

function formatValidationError(err: ValidationError): string {
  const key = err.instancePath.split("/").filter(Boolean)[0] ?? "";
  switch (err.keyword) {
    case "additionalProperties":
      return `Unknown CLI argument: ${String(err.params.additionalProperty)}`;
    case "required":
      return `${String(err.params.missingProperty)} is required`;
    case "enum":
      return `${key} must be one of ${(err.params.allowedValues as unknown[]).join(", ")}`;
    case "type": {
      const t = String(err.params.type);
      const pathSegments = err.instancePath.split("/").filter(Boolean);
      const isArrayItem = pathSegments.some((segment) => /^\d+$/.test(segment));
      if (isArrayItem || t === "array") return `${key} must be an array of strings`;
      if (t === "string") return `${key} must be a string`;
      if (t === "boolean") return `${key} must be a boolean`;
      if (t === "integer") return `${key} must be an integer`;
      if (t === "number") return `${key} must be a number`;
      if (t === "object") return `${key} must be an object`;
      return `${key} must be a ${t}`;
    }
    default:
      return `${key} ${err.message ?? "is invalid"}`;
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
