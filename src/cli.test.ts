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
import { createCliBindings } from "./cli.js";
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
});
