import { beforeAll, describe, expect, test, vi } from "vitest";
import { initTypeChecker, typeCheck } from "./type-checker.js";

vi.mock("@cloudflare/codemode", () => ({
  sanitizeToolName: (name: string) => name.replace(/[^A-Za-z0-9_$]/g, "_"),
  generateTypesFromJsonSchema: () => "",
}));

const { generateBuiltinTypeDefs } = await import("./type-generator.js");

beforeAll(() => {
  initTypeChecker();
});

describe("built-in file tool type definitions", () => {
  test("accept top-level Pi-shaped read, write, and edit", () => {
    const errors = typeCheck(
      `
const text = await read({ path: "src/index.ts" });
await write({ path: "out.txt", content: text });
await edit({
  path: "src/index.ts",
  edits: [{ oldText: "before", newText: "after" }],
});
`,
      generateBuiltinTypeDefs(),
    ).errors;

    expect(errors).toEqual([]);
  });

  test("rejects legacy codemode single-edit shape", () => {
    const errors = typeCheck(
      `await codemode.edit({ path: "x", oldText: "a", newText: "b" });`,
      generateBuiltinTypeDefs(),
    ).errors;

    expect(errors).not.toEqual([]);
  });
});
