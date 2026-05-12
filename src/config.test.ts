import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const temps: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-codemode-config-test-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  test("defaults to normal codemode with QuickJS", () => {
    const config = loadConfig({ homeDir: "/missing-home", projectDir: "/missing-project" });

    expect(config.mode).toBe("on");
    expect(config.executor).toEqual({ type: "quickjs", timeoutMs: 120_000 });
  });

  test("loads explicit on, yolo, and off modes", async () => {
    const projectDir = await tempDir();
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "codemode.json"), JSON.stringify({ mode: "on" }));

    expect(loadConfig({ homeDir: "/missing-home", projectDir }).mode).toBe("on");

    await writeFile(join(projectDir, ".pi", "codemode.json"), JSON.stringify({ mode: "yolo" }));

    expect(loadConfig({ homeDir: "/missing-home", projectDir }).mode).toBe("yolo");

    await writeFile(join(projectDir, ".pi", "codemode.json"), JSON.stringify({ mode: "off" }));

    expect(loadConfig({ homeDir: "/missing-home", projectDir }).mode).toBe("off");
  });

  test("rejects unsupported modes", async () => {
    const projectDir = await tempDir();
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "codemode.json"), JSON.stringify({ mode: "turbo" }));

    expect(() => loadConfig({ homeDir: "/missing-home", projectDir })).toThrow(
      "Unsupported codemode mode 'turbo'",
    );
  });

  test("merges global and project config with project taking precedence", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({ executor: { type: "deno", timeoutMs: 1_000 } }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({ executor: { timeoutMs: 2_000 } }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.executor).toEqual({ type: "deno", timeoutMs: 2_000 });
  });

  test("merges global and project MCP servers with project taking precedence", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({
        mcp: {
          servers: {
            github: { command: "github-global" },
            slack: { command: "slack" },
          },
        },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({
        mcp: {
          servers: {
            github: { command: "github-project" },
          },
        },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.mcp?.servers).toEqual({
      github: { command: "github-project" },
      slack: { command: "slack" },
    });
  });

  test("merges CLI config near MCP config", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({ cli: { git: { backend: "host", operations: ["status"] } } }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({ cli: { gh: { backend: "host", operations: { issueView: {} } } } }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
      gh: { backend: "host", operations: { issueView: {} } },
    });
  });

  test("rejects unsupported executor types", async () => {
    const projectDir = await tempDir();
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({ executor: { type: "node-vm" } }),
    );

    expect(() => loadConfig({ homeDir: "/missing-home", projectDir })).toThrow(
      "Unsupported codemode executor 'node-vm'",
    );
  });
});
