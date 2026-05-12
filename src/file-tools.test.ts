// file-tools.test.ts — Tests for file tool implementations.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "./file-tools.js";

// Helper to create a temp project directory
function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemode-test-"));
  return dir;
}

describe("file tools", () => {
  let projectDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(() => {
    projectDir = createTempProject();
    tools = createFileTools({ projectRoot: projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("reads file content", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      const content = tools.read({ path: "test.txt" });
      expect(content).toBe("hello world");
    });

    it("reads with absolute path within project", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      const content = tools.read({ path: join(projectDir, "test.txt") });
      expect(content).toBe("hello world");
    });

    it("supports offset and limit", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3\nline4\nline5");
      const content = tools.read({ path: "test.txt", offset: 1, limit: 2 });
      expect(content).toBe("line2\nline3");
    });

    it("reads first line with offset 0 limit 1", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3");
      const content = tools.read({ path: "test.txt", offset: 0, limit: 1 });
      expect(content).toBe("line1");
    });

    it("reads multiple lines", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3");
      const content = tools.read({ path: "test.txt", offset: 0, limit: 2 });
      expect(content).toBe("line1\nline2");
    });

    it("reads from middle of file", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3\nline4");
      const content = tools.read({ path: "test.txt", offset: 1, limit: 2 });
      expect(content).toBe("line2\nline3");
    });

    it("returns empty string when offset beyond file length", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2");
      const content = tools.read({ path: "test.txt", offset: 10, limit: 1 });
      expect(content).toBe("");
    });

    it("handles single line file with limit", () => {
      writeFileSync(join(projectDir, "test.txt"), "only line");
      const content = tools.read({ path: "test.txt", offset: 0, limit: 5 });
      expect(content).toBe("only line");
    });

    it("throws error for non-existent file", () => {
      expect(() => tools.read({ path: "nonexistent.txt" })).toThrow(/ENOENT/);
    });

    it("throws error for path outside project", () => {
      expect(() => tools.read({ path: "/etc/passwd" })).toThrow("Path outside project");
    });

    it("throws error for path traversal attempt via ..", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello");
      expect(() => tools.read({ path: "../test.txt" })).toThrow("Path outside project");
    });

    it("throws error for path traversal in nested path", () => {
      expect(() => tools.read({ path: "foo/../../../etc/passwd" })).toThrow("Path outside project");
    });
  });

  describe("write", () => {
    it("writes file content", () => {
      tools.write({ path: "test.txt", content: "hello world" });
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("hello world");
    });

    it("overwrites existing file", () => {
      writeFileSync(join(projectDir, "test.txt"), "old content");
      tools.write({ path: "test.txt", content: "new content" });
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("new content");
    });

    it("creates nested directories", () => {
      tools.write({ path: "nested/dir/test.txt", content: "hello" });
      const content = readFileSync(join(projectDir, "nested/dir/test.txt"), "utf-8");
      expect(content).toBe("hello");
    });

    it("throws error for path outside project", () => {
      expect(() => tools.write({ path: "/etc/test.txt", content: "hello" })).toThrow(
        "Path outside project",
      );
    });

    it("throws error for path traversal attempt", () => {
      expect(() => tools.write({ path: "../test.txt", content: "hello" })).toThrow(
        "Path outside project",
      );
    });
  });

  describe("apply_patch", () => {
    it("applies a unified diff to an existing file", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3\n");

      const result = tools.apply_patch({
        patch: `--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+changed
 line3
`,
      });

      expect(result).toContain("Applied patch to 1 file");
      expect(readFileSync(join(projectDir, "test.txt"), "utf-8")).toBe("line1\nchanged\nline3\n");
    });

    it("reports clear hunk failure diagnostics", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3\n");

      expect(() =>
        tools.apply_patch({
          patch: `--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-missing
+changed
 line3
`,
        }),
      ).toThrow(/Hunk failed for test\.txt at -1,3/);
    });

    it("rejects path traversal in patch file paths", () => {
      expect(() =>
        tools.apply_patch({
          patch: `--- a/../outside.txt
+++ b/../outside.txt
@@ -0,0 +1 @@
+oops
`,
        }),
      ).toThrow("Path outside project");
    });

    it("accepts documented Begin Patch update format", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3\n");

      const result = tools.apply_patch({
        patch: `*** Begin Patch
*** Update File: test.txt
@@
 line1
-line2
+changed
 line3
*** End Patch
`,
      });

      expect(result).toContain("Applied patch to 1 file");
      expect(result).toContain("--- a/test.txt");
      expect(result).toContain("+++ b/test.txt");
      expect(result).toContain("-line2");
      expect(result).toContain("+changed");
      expect(readFileSync(join(projectDir, "test.txt"), "utf-8")).toBe("line1\nchanged\nline3\n");
    });

    it("returns a visible diff for replace_in_file results", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world\n");

      const result = tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "world", newText: "universe" }],
      });

      expect(result).toContain("Replaced 1 occurrence in test.txt");
      expect(result).toContain("--- a/test.txt");
      expect(result).toContain("+++ b/test.txt");
      expect(result).toContain("-hello world");
      expect(result).toContain("+hello universe");
    });

    it("keeps visible diffs focused around changed lines", () => {
      writeFileSync(join(projectDir, "test.txt"), "keep1\nkeep2\nold\nkeep3\nkeep4\nkeep5\n");

      const result = tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "old", newText: "new" }],
      });

      expect(result).toContain(" keep2");
      expect(result).toContain("-old");
      expect(result).toContain("+new");
      expect(result).not.toContain(" keep5");
    });
  });

  describe("replace_in_file", () => {
    it("replaces single occurrence", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      const result = tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "world", newText: "universe" }],
      });
      expect(result).toContain("Replaced 1 occurrence");
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("hello universe");
    });

    it("replaces multiple occurrences with multiple edits", () => {
      writeFileSync(join(projectDir, "test.txt"), "a b c");
      const result = tools.replace_in_file({
        path: "test.txt",
        edits: [
          { oldText: "a", newText: "x" },
          { oldText: "b", newText: "y" },
          { oldText: "c", newText: "z" },
        ],
      });
      expect(result).toContain("Replaced 3 occurrences");
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("x y z");
    });

    it("throws error when oldText not found", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      expect(() =>
        tools.replace_in_file({
          path: "test.txt",
          edits: [{ oldText: "nonexistent", newText: "replacement" }],
        }),
      ).toThrow('oldText not found: "nonexistent"');
    });

    it("throws error when oldText matches multiple times", () => {
      writeFileSync(join(projectDir, "test.txt"), "a a a");
      expect(() =>
        tools.replace_in_file({
          path: "test.txt",
          edits: [{ oldText: "a", newText: "b" }],
        }),
      ).toThrow('oldText matches 3 times, expected exactly 1: "a"');
    });

    it("throws error when edits overlap", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      expect(() =>
        tools.replace_in_file({
          path: "test.txt",
          edits: [
            { oldText: "hello world", newText: "hi" },
            { oldText: "hello", newText: "hey" },
          ],
        }),
      ).toThrow("overlap");
    });

    it("handles multiline replacements", () => {
      writeFileSync(join(projectDir, "test.txt"), "line1\nline2\nline3");
      const result = tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "line2", newText: "newLine2" }],
      });
      expect(result).toContain("Replaced 1 occurrence");
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("line1\nnewLine2\nline3");
    });

    it("throws error for path outside project", () => {
      expect(() =>
        tools.replace_in_file({
          path: "/etc/passwd",
          edits: [{ oldText: "a", newText: "b" }],
        }),
      ).toThrow("Path outside project");
    });

    it("throws error for non-existent file", () => {
      expect(() =>
        tools.replace_in_file({
          path: "nonexistent.txt",
          edits: [{ oldText: "a", newText: "b" }],
        }),
      ).toThrow(/ENOENT/);
    });

    it("handles edits at start of file", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "hello", newText: "hi" }],
      });
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("hi world");
    });

    it("handles edits at end of file", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: "world", newText: "universe" }],
      });
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("hello universe");
    });

    it("handles replacement with empty string", () => {
      writeFileSync(join(projectDir, "test.txt"), "hello world");
      tools.replace_in_file({
        path: "test.txt",
        edits: [{ oldText: " world", newText: "" }],
      });
      const content = readFileSync(join(projectDir, "test.txt"), "utf-8");
      expect(content).toBe("hello");
    });
  });
});
