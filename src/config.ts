// config.ts — Codemode configuration loading.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorKind } from "./executor/index.js";

export type CodemodeMode = "off" | "on" | "yolo";

export interface JevConfig {
  /** Path to a file containing the TypeSafe API key (trimmed). Prefer env or secrets file for v0. */
  apiKeyFile?: string;
  /** HTTP timeout for jev.ask in milliseconds (default 8000). */
  timeoutMs?: number;
  /** System One model id (default jev-latest). */
  model?: string;
  /** Maximum serialized state size sent to TypeSafe (default 12000 chars). */
  stateMaxChars?: number;
}

export interface CodemodeConfig {
  mode: CodemodeMode;
  executor: {
    type: ExecutorKind;
    timeoutMs: number;
  };
  /** When true in the global file, project mode/cli overrides are ignored. */
  lock?: boolean;
  mcp?: {
    servers?: Record<string, unknown>;
  };
  cli?: CliConfig;
  jev?: JevConfig;
}

export type CliConfig = Record<string, CliToolConfig>;

export interface CliToolConfig {
  backend: "host";
  command?: string;
  operations: string[] | Record<string, CliOperationConfig>;
}

export interface CliOperationConfig {
  timeoutMs?: number;
}

export interface LoadConfigOptions {
  homeDir?: string;
  projectDir?: string;
}

type ConfigInput = Omit<Partial<CodemodeConfig>, "executor"> & {
  executor?: Partial<CodemodeConfig["executor"]>;
};

interface ReadConfigResult {
  config: ConfigInput;
  /** Top-level keys present in the JSON file (not inferred defaults). */
  explicitKeys: Set<string>;
}

const DEFAULT_CONFIG: CodemodeConfig = {
  mode: "on",
  executor: {
    type: "quickjs",
    timeoutMs: 120_000,
  },
};

const EXECUTOR_KINDS = new Set<ExecutorKind>(["quickjs", "deno"]);
const CODEMODE_MODES = new Set<CodemodeMode>(["off", "on", "yolo"]);
const MODE_PERMISSIVENESS: Record<CodemodeMode, number> = { off: 0, on: 1, yolo: 2 };

/**
 * Load codemode configuration from global and project config files.
 *
 * Global: ~/.pi/agent/codemode.json
 * Project: $PROJECT/.pi/codemode.json
 *
 * When the global file explicitly sets `mode` or `cli`, the project file may only
 * narrow (never widen) those settings. Global `lock: true` ignores project mode/cli.
 */
export function loadConfig(options: LoadConfigOptions = {}): CodemodeConfig {
  const homeDir = options.homeDir ?? homedir();
  const projectDir = options.projectDir ?? process.cwd();
  const global = readConfigFile(join(homeDir, ".pi", "agent", "codemode.json"));
  const project = readConfigFile(join(projectDir, ".pi", "codemode.json"));

  const base = mergeConfig(DEFAULT_CONFIG, global.config);
  const withPolicy = applyProjectPolicy(base, global, project);
  return normalizeConfig(withPolicy);
}

function readConfigFile(path: string): ReadConfigResult {
  if (!existsSync(path)) return { config: {}, explicitKeys: new Set() };

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Codemode config must be a JSON object: ${path}`);
  }
  return {
    config: parsed as ConfigInput,
    explicitKeys: new Set(Object.keys(parsed)),
  };
}

function mergeConfig(base: ConfigInput, override: ConfigInput): ConfigInput {
  return {
    ...base,
    ...override,
    executor:
      base.executor || override.executor
        ? {
            ...base.executor,
            ...override.executor,
          }
        : undefined,
    mcp:
      base.mcp || override.mcp
        ? {
            ...base.mcp,
            ...override.mcp,
            servers:
              base.mcp?.servers || override.mcp?.servers
                ? {
                    ...base.mcp?.servers,
                    ...override.mcp?.servers,
                  }
                : undefined,
          }
        : undefined,
    cli:
      base.cli || override.cli
        ? {
            ...base.cli,
            ...override.cli,
          }
        : undefined,
    jev:
      base.jev || override.jev
        ? {
            ...base.jev,
            ...override.jev,
          }
        : undefined,
  };
}

/**
 * Merge project settings without widening a global mode/cli pin.
 * MCP and executor follow the normal shallow merge rules.
 */
function applyProjectPolicy(
  base: ConfigInput,
  global: ReadConfigResult,
  project: ReadConfigResult,
): ConfigInput {
  const policyLocked = global.explicitKeys.has("lock") && global.config.lock === true;
  const projectBody = policyLocked ? stripPolicyKeys(project.config) : project.config;
  const merged = mergeConfig(base, projectBody);

  if (policyLocked) return merged;

  if (global.explicitKeys.has("mode")) {
    const projectMode = project.explicitKeys.has("mode") ? project.config.mode : undefined;
    merged.mode = narrowMode(base.mode ?? DEFAULT_CONFIG.mode, projectMode);
  }

  if (global.explicitKeys.has("cli")) {
    if (project.explicitKeys.has("cli") && project.config.cli) {
      merged.cli = intersectCli(base.cli, project.config.cli);
    } else {
      merged.cli = base.cli;
    }
  }

  return merged;
}

function stripPolicyKeys(config: ConfigInput): ConfigInput {
  const { mode: _mode, cli: _cli, lock: _lock, ...rest } = config;
  return rest;
}

function narrowMode(globalMode: CodemodeMode, projectMode?: CodemodeMode): CodemodeMode {
  if (!projectMode) return globalMode;
  const globalLevel = MODE_PERMISSIVENESS[globalMode];
  const projectLevel = MODE_PERMISSIVENESS[projectMode];
  return projectLevel <= globalLevel ? projectMode : globalMode;
}

function intersectCli(
  globalCli: CliConfig | undefined,
  projectCli: CliConfig,
): CliConfig | undefined {
  if (!globalCli) return undefined;

  const result: CliConfig = {};
  for (const [toolName, globalTool] of Object.entries(globalCli)) {
    const projectTool = projectCli[toolName];
    if (!projectTool) continue;

    const intersectedOps = intersectOperations(globalTool.operations, projectTool.operations);
    if (intersectedOps === undefined) continue;

    result[toolName] = {
      backend: globalTool.backend,
      ...(globalTool.command !== undefined ? { command: globalTool.command } : {}),
      operations: intersectedOps,
    };
  }
  return Object.keys(result).length > 0 ? result : {};
}

function intersectOperations(
  globalOps: string[] | Record<string, CliOperationConfig>,
  projectOps: string[] | Record<string, CliOperationConfig>,
): string[] | Record<string, CliOperationConfig> | undefined {
  if (Array.isArray(globalOps)) {
    const projectNames = normalizeOperationNames(projectOps);
    const kept = globalOps.filter((op) => projectNames.has(op));
    return kept.length > 0 ? kept : undefined;
  }

  const projectNames = normalizeOperationNames(projectOps);
  const result: Record<string, CliOperationConfig> = {};
  for (const [name, config] of Object.entries(globalOps)) {
    if (!projectNames.has(name)) continue;
    const projectConfig = Array.isArray(projectOps)
      ? {}
      : (projectOps as Record<string, CliOperationConfig>)[name];
    result[name] = {
      ...config,
      ...projectConfig,
      timeoutMs: config.timeoutMs ?? projectConfig?.timeoutMs,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeOperationNames(ops: string[] | Record<string, CliOperationConfig>): Set<string> {
  if (Array.isArray(ops)) return new Set(ops);
  return new Set(Object.keys(ops));
}

function normalizeConfig(config: ConfigInput): CodemodeConfig {
  const mode = config.mode ?? DEFAULT_CONFIG.mode;
  if (!CODEMODE_MODES.has(mode)) {
    throw new Error(`Unsupported codemode mode '${String(mode)}'. Supported modes: off, on, yolo`);
  }

  const executor = config.executor ?? DEFAULT_CONFIG.executor;
  const type = executor.type ?? DEFAULT_CONFIG.executor.type;
  if (!EXECUTOR_KINDS.has(type)) {
    throw new Error(
      `Unsupported codemode executor '${String(type)}'. Supported executors: quickjs, deno`,
    );
  }

  const cli = normalizeCliConfig(config.cli);
  const lock = config.lock === true ? true : undefined;

  return {
    ...config,
    mode,
    executor: {
      type,
      timeoutMs: executor.timeoutMs ?? DEFAULT_CONFIG.executor.timeoutMs,
    },
    cli,
    lock,
  };
}

function normalizeCliConfig(cli: CodemodeConfig["cli"]): CodemodeConfig["cli"] {
  if (!cli) return undefined;
  const normalized: CliConfig = {};
  for (const [toolName, toolConfig] of Object.entries(cli)) {
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error(`Invalid CLI tool config for '${toolName}'`);
    }
    const backend = (toolConfig as CliToolConfig).backend;
    if (backend !== "host") {
      throw new Error(
        `Unsupported CLI backend '${String(backend)}' for cli.${toolName}. Only 'host' is supported`,
      );
    }
    normalized[toolName] = toolConfig as CliToolConfig;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
