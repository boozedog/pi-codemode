import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { resolveJevApiKey } from "./key.js";

const temps: string[] = [];

async function tempDir() {
  const dir = join(tmpdir(), `pi-codemode-jev-key-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveJevApiKey", () => {
  test("prefers TYPESAFE_API_KEY over files", async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent", "secrets"), { recursive: true });
    await writeFile(join(homeDir, ".pi", "agent", "secrets", "typesafe_api_key"), "file-key\n");
    const key = resolveJevApiKey({
      homeDir,
      env: { TYPESAFE_API_KEY: "env-key" },
      jevConfig: { apiKeyFile: join(homeDir, "custom.key") },
    });
    expect(key).toBe("env-key");
  });

  test("reads jev.apiKeyFile when env is unset", async () => {
    const homeDir = await tempDir();
    const custom = join(homeDir, "custom.key");
    await writeFile(custom, " custom-key \n");
    const key = resolveJevApiKey({ homeDir, env: {}, jevConfig: { apiKeyFile: custom } });
    expect(key).toBe("custom-key");
  });

  test("falls back to ~/.pi/agent/secrets/typesafe_api_key", async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent", "secrets"), { recursive: true });
    await writeFile(join(homeDir, ".pi", "agent", "secrets", "typesafe_api_key"), "secret\n");
    const key = resolveJevApiKey({ homeDir, env: {} });
    expect(key).toBe("secret");
  });

  test("returns undefined when no key is configured", async () => {
    const homeDir = await tempDir();
    expect(resolveJevApiKey({ homeDir, env: {} })).toBeUndefined();
  });
});
