import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRunInvocation, resolveJobEntry, serializeJobResult } from "./runner.js";

describe("job runner helpers", () => {
  test.each([
    ["daily-mail date=2026-08-10", { job: "daily-mail", args: { date: "2026-08-10" } }],
    [
      "daily-mail --date=2026-08-10 --verbose",
      { job: "daily-mail", args: { date: "2026-08-10", verbose: "true" } },
    ],
    ["daily-mail --date 2026-08-10", { job: "daily-mail", args: { date: "2026-08-10" } }],
    ["daily-mail --note a=b", { job: "daily-mail", args: { note: "a=b" } }],
    ["daily-mail --flag", { job: "daily-mail", args: { flag: "true" } }],
    ["daily-mail note='hello world'", { job: "daily-mail", args: { note: "hello world" } }],
    ["daily-mail", { job: "daily-mail", args: {} }],
  ])("parses %s", (input, expected) => {
    expect(parseRunInvocation(input)).toEqual(expected);
  });

  test("last duplicate argument wins", () => {
    expect(parseRunInvocation("job key=one --key two")).toEqual({
      job: "job",
      args: { key: "two" },
    });
  });

  test.each(["", "job unexpected", "job --"])("rejects invalid invocation %s", (input) => {
    expect(() => parseRunInvocation(input)).toThrow(/Usage|Invalid/);
  });

  test("resolves metadata entry before default entries", () => {
    const root = mkdtempSync(join(tmpdir(), "codemode-job-"));
    try {
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "SKILL.md"),
        "---\nname: demo\ndescription: test\nmetadata:\n  codemode-entry: custom.ts\n---\n",
      );
      writeFileSync(join(root, "custom.ts"), "return 1;");
      writeFileSync(join(root, "scripts", "main.ts"), "return 2;");
      expect(resolveJobEntry(root)).toBe(join(root, "custom.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a quoted flat metadata entry", () => {
    const root = mkdtempSync(join(tmpdir(), "codemode-job-"));
    try {
      writeFileSync(
        join(root, "SKILL.md"),
        "---\nname: demo\ndescription: test\nmetadata:\n  codemode-entry: 'main.ts'\n---\n",
      );
      writeFileSync(join(root, "main.ts"), "return 1;");
      expect(resolveJobEntry(root)).toBe(join(root, "main.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes job values with the cron stdout contract", () => {
    expect(serializeJobResult(undefined)).toBe("");
    expect(serializeJobResult("ok")).toBe("ok\n");
    expect(serializeJobResult(3n)).toBe("3\n");
    expect(serializeJobResult(null)).toBe("null\n");
    expect(serializeJobResult({ ok: true })).toBe('{"ok":true}\n');
    expect(serializeJobResult({ count: 3n })).toBe('{"count":"3"}\n');
  });
});
