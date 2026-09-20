// key.ts — Resolve the TypeSafe API key for optional guest jev.ask.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JevConfig } from "../config.js";

export interface ResolveJevKeyOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  jevConfig?: JevConfig;
}

function readTrimmedKeyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Resolve a TypeSafe API key. First present value wins:
 * 1. TYPESAFE_API_KEY
 * 2. jev.apiKeyFile
 * 3. ~/.pi/agent/secrets/typesafe_api_key
 */
export function resolveJevApiKey(options: ResolveJevKeyOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const apiKeyFile = options.jevConfig?.apiKeyFile;
  if (apiKeyFile) {
    const fromFile = readTrimmedKeyFile(apiKeyFile);
    if (fromFile) return fromFile;
  }

  const defaultPath = join(
    options.homeDir ?? homedir(),
    ".pi",
    "agent",
    "secrets",
    "typesafe_api_key",
  );
  return readTrimmedKeyFile(defaultPath);
}
