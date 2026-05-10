import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: () => ({ type: "string" }),
    Optional: (schema: unknown) => schema,
    Record: () => ({ type: "object" }),
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Text: class Text {
    constructor(public text: string) {}
  },
}));
import { buildCliArgv, createCliBindings, listJustBashCommands } from "./cli.js";
import { QuickJsExecutor } from "./executor/quickjs-executor.js";
import { generateBuiltinTypeDefs } from "./type-generator.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "pi-codemode-cli-test-"));
  dirs.push(dir);
  return dir;
}

describe("cli command capabilities", () => {
  test("type definitions include configured cli operations only", () => {
    const types = generateBuiltinTypeDefs({
      cli: { git: { backend: "host", operations: ["status"] } },
    });

    expect(types).toContain("declare const cli: CliTools");
    expect(types).toContain("git: { status(args?: { short?: boolean; branch?: boolean })");
    expect(types).not.toContain("issueView");
  });

  test("type definitions allow overriding gh list json fields", () => {
    const types = generateBuiltinTypeDefs({
      cli: { gh: { backend: "host", operations: ["issueList", "prList"] } },
    });

    expect(types).toContain(
      'issueList(args?: { repo?: string; state?: "open" | "closed" | "all"; limit?: number; json?: string[] })',
    );
    expect(types).toContain(
      'prList(args?: { repo?: string; state?: "open" | "closed" | "all"; limit?: number; json?: string[] })',
    );
  });

  test("runs configured host-backed ripgrep with typed args", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "alpha\nbeta\n");
    const bindings = {
      cli: createCliBindings({ rg: { backend: "host", operations: ["search"] } }, cwd),
    };

    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      'return await cli.rg.search({ pattern: "alpha", paths: ["a.txt"], lineNumber: true });',
      bindings,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ exitCode: 0 });
    expect(String((result.result as { stdout: string }).stdout)).toContain("alpha");
  });

  test("rejects unconfigured operations before execution", async () => {
    const cwd = tempProject();
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.git.status({ short: true });",
      { cli: createCliBindings({}, cwd) },
    );

    expect(result.error).toContain("cli.git.status");
  });

  test("allows read-only operations to use the just-bash backend", () => {
    const cwd = tempProject();

    expect(() =>
      createCliBindings({ find: { backend: "just-bash", operations: ["files"] } }, cwd),
    ).not.toThrow();
  });

  test("discovers just-bash commands without auto-exposing operations", () => {
    const commands = listJustBashCommands();
    const types = generateBuiltinTypeDefs({});

    expect(commands).toContain("find");
    expect(commands).toContain("grep");
    expect(types).not.toContain("find:");
  });

  test("rejects unavailable just-bash commands", () => {
    const cwd = tempProject();

    expect(() =>
      createCliBindings({ git: { backend: "just-bash", operations: ["status"] } }, cwd),
    ).toThrow("just-bash command is not available: git");
  });

  test("rejects non-read operations configured with the just-bash backend", () => {
    const cwd = tempProject();

    expect(() =>
      createCliBindings({ gh: { backend: "just-bash", operations: ["issueView"] } }, cwd),
    ).toThrow(
      "Operation cli.gh.issueView cannot use just-bash backend because it is not read-only",
    );
  });

  test("unsupported write-like operations are not exposed", async () => {
    const cwd = tempProject();
    const bindings = {
      cli: createCliBindings({ git: { backend: "host", operations: ["commit"] } }, cwd),
    };
    const types = generateBuiltinTypeDefs({
      cli: { git: { backend: "host", operations: ["commit"] } },
    });

    expect(types).not.toContain("commit");
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.git.commit({ message: 'nope' });",
      bindings,
    );

    expect(result.error).toContain("cli.git.commit");
  });

  test("builds argv for supported operations", () => {
    expect(buildCliArgv("git", "status", {})).toEqual(["status"]);
    expect(buildCliArgv("git", "status", { short: true, branch: true })).toEqual([
      "status",
      "--short",
      "--branch",
    ]);
    expect(buildCliArgv("git", "branch", { showCurrent: true })).toEqual([
      "branch",
      "--show-current",
    ]);
    expect(buildCliArgv("gh", "issueView", { number: 13, repo: "owner/repo" })).toEqual([
      "issue",
      "view",
      "13",
      "--repo",
      "owner/repo",
      "--json",
      "number,title,state,url,body,author,createdAt,updatedAt,labels,assignees,comments",
    ]);
    expect(buildCliArgv("gh", "issueView", { number: 13, json: ["title", "state"] })).toEqual([
      "issue",
      "view",
      "13",
      "--json",
      "title,state",
    ]);
    expect(
      buildCliArgv("gh", "issueList", { state: "open", limit: 5, repo: "owner/repo" }),
    ).toEqual([
      "issue",
      "list",
      "--repo",
      "owner/repo",
      "--state",
      "open",
      "--limit",
      "5",
      "--json",
      "number,title,state,url,author,createdAt,updatedAt,labels,assignees,comments",
    ]);
    expect(buildCliArgv("gh", "prView", { number: 7 })).toEqual([
      "pr",
      "view",
      "7",
      "--json",
      "number,title,state,url,body,author,createdAt,updatedAt,labels,assignees,comments,headRefName,baseRefName,isDraft,mergeable",
    ]);
    expect(buildCliArgv("gh", "prList", { state: "all" })).toEqual([
      "pr",
      "list",
      "--state",
      "all",
      "--json",
      "number,title,state,url,author,createdAt,updatedAt,labels,assignees,comments,headRefName,baseRefName,isDraft",
    ]);
    expect(
      buildCliArgv("rg", "search", {
        pattern: "TODO",
        glob: ["*.ts"],
        paths: ["src"],
        maxCount: 2,
        hidden: true,
        ignoreCase: true,
      }),
    ).toEqual(["--ignore-case", "--hidden", "--max-count", "2", "--glob", "*.ts", "TODO", "src"]);
    expect(buildCliArgv("find", "files", {})).toEqual(["."]);
    expect(
      buildCliArgv("find", "files", { path: "src", maxDepth: 3, name: "*.ts", type: "file" }),
    ).toEqual(["src", "-maxdepth", "3", "-name", "*.ts", "-type", "f"]);
    expect(buildCliArgv("find", "files", { type: "directory" })).toContain("d");
    expect(
      buildCliArgv("grep", "search", {
        pattern: "x",
        paths: ["src"],
        recursive: true,
        ignoreCase: true,
      }),
    ).toEqual(["-R", "-i", "x", "src"]);
    expect(buildCliArgv("ls", "list", { all: true, long: true, path: "src" })).toEqual([
      "-a",
      "-l",
      "src",
    ]);
  });

  test("validates runtime argument shapes", () => {
    expect(() => buildCliArgv("rg", "search", { pattern: "x", paths: [1] })).toThrow(
      "paths must be an array of strings",
    );
    expect(() => buildCliArgv("gh", "issueList", { state: "merged" })).toThrow(
      "state must be one of open, closed, all",
    );
    expect(() => buildCliArgv("find", "files", { type: "symlink" })).toThrow(
      "type must be one of file, directory",
    );
  });

  test("unconfigured operations return clear denial errors", async () => {
    const cwd = tempProject();
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.git.status({ short: true });",
      { cli: createCliBindings({}, cwd) },
    );

    expect(result.error).toContain("CLI operation is not configured: cli.git.status");
  });

  test("maps missing executables to cli errors", async () => {
    const cwd = tempProject();
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.rg.search({ pattern: 'x' });",
      {
        cli: createCliBindings(
          { rg: { backend: "host", command: "definitely-missing-rg", operations: ["search"] } },
          cwd,
        ),
      },
    );

    expect(result.error).toContain(
      "CLI executable not found for cli.rg.search: definitely-missing-rg",
    );
  });

  test("host commands truncate large output and keep exit code", async () => {
    const cwd = tempProject();
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      `return await cli.ls.list({ path: ${JSON.stringify("x".repeat(60 * 1024))} });`,
      {
        cli: createCliBindings(
          { ls: { backend: "host", command: "/bin/echo", operations: ["list"] } },
          cwd,
        ),
      },
    );

    expect(result.error).toBeUndefined();
    const stdout = String((result.result as { stdout: string }).stdout);
    expect(stdout.length).toBeLessThan(53 * 1024);
    expect(stdout).toContain("[Output truncated");
    expect(result.result).toMatchObject({ exitCode: 0 });
  });

  test("host commands truncate stderr independently", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "emit-stderr.js"), "process.stderr.write('e'.repeat(60 * 1024));\n");
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.ls.list({ path: 'emit-stderr.js' });",
      {
        cli: createCliBindings(
          { ls: { backend: "host", command: process.execPath, operations: ["list"] } },
          cwd,
        ),
      },
    );

    expect(result.error).toBeUndefined();
    const stderr = String((result.result as { stderr: string }).stderr);
    expect(stderr.length).toBeLessThan(53 * 1024);
    expect(stderr).toContain("[Output truncated");
  });

  test("host commands receive authentication-related environment", async () => {
    const cwd = tempProject();
    writeFileSync(
      join(cwd, "status"),
      "process.stdout.write(JSON.stringify({ HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN }));\n",
    );
    const previousToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "test-token";
    try {
      const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
        "return await cli.git.status({});",
        {
          cli: createCliBindings(
            { git: { backend: "host", command: process.execPath, operations: ["status"] } },
            cwd,
          ),
        },
      );

      expect(result.error).toBeUndefined();
      expect(JSON.parse(String((result.result as { stdout: string }).stdout))).toMatchObject({
        HOME: process.env.HOME,
        GH_TOKEN: "test-token",
      });
    } finally {
      if (previousToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousToken;
    }
  });

  test("host command non-zero exits are returned without throwing", async () => {
    const cwd = tempProject();
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.git.status({});",
      {
        cli: createCliBindings(
          { git: { backend: "host", command: "/usr/bin/false", operations: ["status"] } },
          cwd,
        ),
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ exitCode: 1 });
  });

  test("host command timeouts are classified", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "status"), "setTimeout(() => {}, 1000);\n");
    const result = await new QuickJsExecutor({ timeout: 10_000 }).execute(
      "return await cli.git.status({});",
      {
        cli: createCliBindings(
          {
            git: {
              backend: "host",
              command: process.execPath,
              operations: { status: { timeoutMs: 50 } },
            },
          },
          cwd,
        ),
      },
    );

    expect(result.error).toContain("CLI operation timed out after 50ms: cli.git.status");
  });
});
