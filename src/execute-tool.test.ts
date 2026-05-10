import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createFileTools } from "./file-tools.js";
import type { ToolBindings } from "./tool-bindings.js";

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: () => ({ type: "string" }),
    Optional: (schema: unknown) => schema,
    Record: () => ({ type: "object" }),
  },
}));

const { createExecuteTool } = await import("./execute-tool.js");

const bindings = {
  read: async () => "",
  write: async () => undefined,
  edit: async () => "",
  search_tools: async () => "",
  describe_tools: async () => "",
  $: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  shell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  progress: () => undefined,
} satisfies ToolBindings;

describe("createExecuteTool executor selection", () => {
  test("uses the configured executor", async () => {
    const tool = createExecuteTool({
      typeDefs: "",
      bindings,
      timeout: 1_000,
      executor: { kind: "deno", deno: { denoPath: "definitely-not-a-deno-binary" } },
    });

    const result = await tool.execute(
      "call-id",
      { code: "return 1;" },
      undefined,
      () => undefined,
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Configured executor 'deno' is unavailable");
  });
});

describe("execute_tools integration", () => {
  test("executes QuickJS code against real file read binding", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "codemode-execute-tool-"));
    try {
      writeFileSync(join(projectDir, "hello.txt"), "hello from file");
      const fileTools = createFileTools({ projectRoot: projectDir });
      const tool = createExecuteTool({
        typeDefs: "declare function read(params: { path: string }): Promise<string>;",
        bindings: {
          ...bindings,
          read: async (params) => fileTools.read(params),
        },
        timeout: 1_000,
        executor: { kind: "quickjs" },
      });

      const result = await tool.execute(
        "call-id",
        { code: 'return await read({ path: "hello.txt" });' },
        undefined,
        () => undefined,
        {} as never,
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("hello from file");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
