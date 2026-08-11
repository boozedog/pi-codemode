import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveJobEntry, serializeJobResult } from "./runner.js";

describe("job runner helpers", () => {
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
