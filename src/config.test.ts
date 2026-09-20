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

  test("merges CLI config when global does not pin cli", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({ executor: { timeoutMs: 1_000 } }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({
        cli: {
          git: { backend: "host", operations: ["status"] },
          gh: { backend: "host", operations: { issueView: {} } },
        },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
      gh: { backend: "host", operations: { issueView: {} } },
    });
  });

  test("global cli pin prevents project from adding tools or operations", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({
        mode: "on",
        cli: { git: { backend: "host", operations: ["status"] } },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({
        mode: "yolo",
        cli: {
          git: { backend: "host", operations: ["status", "push"] },
          gh: { backend: "host", operations: ["issueView"] },
        },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.mode).toBe("on");
    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
    });
  });

  test("project cli may subtract operations from a global cli pin", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({
        cli: {
          git: { backend: "host", operations: ["status", "diff"] },
          gh: { backend: "host", operations: ["issueView", "issueList"] },
        },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({
        cli: {
          git: { backend: "host", operations: ["status"] },
        },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
    });
  });

  test("global mode pin allows project to lower permissiveness", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({ mode: "yolo" }),
    );
    await writeFile(join(projectDir, ".pi", "codemode.json"), JSON.stringify({ mode: "on" }));

    expect(loadConfig({ homeDir, projectDir }).mode).toBe("on");
  });

  test("lock: true ignores project mode and cli", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({
        lock: true,
        mode: "on",
        cli: { git: { backend: "host", operations: ["status"] } },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({
        mode: "yolo",
        cli: { git: { backend: "host", operations: ["push"] } },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.lock).toBe(true);
    expect(config.mode).toBe("on");
    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
    });
  });

  test("missing project file keeps global policy pin", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({
        mode: "on",
        cli: { git: { backend: "host", operations: ["status"] } },
      }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.mode).toBe("on");
    expect(config.cli).toEqual({
      git: { backend: "host", operations: ["status"] },
    });
  });

  test("rejects just-bash CLI backend", async () => {
    const projectDir = await tempDir();
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({ cli: { find: { backend: "just-bash", operations: ["files"] } } }),
    );

    expect(() => loadConfig({ homeDir: "/missing-home", projectDir })).toThrow(
      "Unsupported CLI backend 'just-bash'",
    );
  });

  test("deep-merges jev config between global and project files", async () => {
    const homeDir = await tempDir();
    const projectDir = await tempDir();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "codemode.json"),
      JSON.stringify({ jev: { timeoutMs: 5_000, model: "jev-latest" } }),
    );
    await writeFile(
      join(projectDir, ".pi", "codemode.json"),
      JSON.stringify({ jev: { stateMaxChars: 4_000 } }),
    );

    const config = loadConfig({ homeDir, projectDir });

    expect(config.jev).toEqual({
      timeoutMs: 5_000,
      model: "jev-latest",
      stateMaxChars: 4_000,
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
