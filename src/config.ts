// config.ts — Codemode configuration loading.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorKind } from "./executor/index.js";

export interface CodemodeConfig {
  executor: {
    type: ExecutorKind;
    timeoutMs: number;
  };
  mcp?: {
    servers?: Record<string, unknown>;
  };
}

export interface LoadConfigOptions {
  homeDir?: string;
  projectDir?: string;
}

type ConfigInput = Omit<Partial<CodemodeConfig>, "executor"> & {
  executor?: Partial<CodemodeConfig["executor"]>;
};

const DEFAULT_CONFIG: CodemodeConfig = {
  executor: {
    type: "quickjs",
    timeoutMs: 120_000,
  },
};

const EXECUTOR_KINDS = new Set<ExecutorKind>(["quickjs", "deno"]);

/**
 * Load codemode configuration from global and project config files.
 *
 * Global: ~/.pi/agent/codemode.json
 * Project: $PROJECT/.pi/codemode.json
 */
export function loadConfig(options: LoadConfigOptions = {}): CodemodeConfig {
  const homeDir = options.homeDir ?? homedir();
  const projectDir = options.projectDir ?? process.cwd();
  const globalConfig = readConfigFile(join(homeDir, ".pi", "agent", "codemode.json"));
  const projectConfig = readConfigFile(join(projectDir, ".pi", "codemode.json"));

  return normalizeConfig(mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig));
}

function readConfigFile(path: string): ConfigInput {
  if (!existsSync(path)) return {};

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Codemode config must be a JSON object: ${path}`);
  }
  return parsed as ConfigInput;
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
  };
}

function normalizeConfig(config: ConfigInput): CodemodeConfig {
  const executor = config.executor ?? DEFAULT_CONFIG.executor;
  const type = executor.type ?? DEFAULT_CONFIG.executor.type;
  if (!EXECUTOR_KINDS.has(type)) {
    throw new Error(
      `Unsupported codemode executor '${String(type)}'. Supported executors: quickjs, deno`,
    );
  }

  return {
    ...config,
    executor: {
      type,
      timeoutMs: executor.timeoutMs ?? DEFAULT_CONFIG.executor.timeoutMs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
