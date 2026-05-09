import { describe, expect, test } from "vitest";
import { DenoExecutor, QuickJsExecutor, createExecutor } from "./index.js";

describe("createExecutor", () => {
  test("defaults to QuickJS", () => {
    expect(createExecutor()).toBeInstanceOf(QuickJsExecutor);
  });

  test("creates QuickJS explicitly", () => {
    expect(createExecutor({ kind: "quickjs" })).toBeInstanceOf(QuickJsExecutor);
  });

  test("keeps Deno available as an optional executor", () => {
    expect(createExecutor({ kind: "deno" })).toBeInstanceOf(DenoExecutor);
  });
});
