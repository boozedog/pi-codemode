import { describe, expect, test, vi } from "vitest";
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
