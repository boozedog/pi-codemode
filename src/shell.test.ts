import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeAll, beforeEach, afterEach } from "vitest";
import {
  initShell,
  executeJustBash,
  createShellTag,
  createShellFunction,
  generateShellTypeDefs,
  disposeShell,
  disposeAllShells,
} from "./shell.js";

// Note: just-bash uses WASM and may require specific environment setup.
// These tests verify the shell API and policy enforcement.

describe("shell", () => {
  const projectRoot = "/tmp/test-project";

  // Ensure test directory exists
  beforeAll(() => {
    const fs = require("fs");
    if (!fs.existsSync(projectRoot)) {
      fs.mkdirSync(projectRoot, { recursive: true });
    }
  });

  beforeEach(async () => {
    await disposeAllShells();
  });

  afterEach(async () => {
    await disposeAllShells();
  });

  describe("initShell", () => {
    test("initializes shell context for a project", async () => {
      await expect(initShell({ projectRoot })).resolves.toBeUndefined();
    });

    test("re-initializes when called again for same project", async () => {
      await initShell({ projectRoot });
      await expect(initShell({ projectRoot })).resolves.toBeUndefined();
    });
  });

  describe("executeJustBash", () => {
    test("throws when shell not initialized", async () => {
      await disposeShell(projectRoot);
      await expect(executeJustBash(projectRoot, "echo hello")).rejects.toThrow(
        "Shell not initialized",
      );
    });

    test("returns error for denied commands", async () => {
      await initShell({
        projectRoot,
        deniedCommands: ["curl"],
      });

      const result = await executeJustBash(projectRoot, "curl http://example.com");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Command "curl" is not allowed');
    });

    test("returns error for commands not in allowlist", async () => {
      await initShell({
        projectRoot,
        allowedCommands: ["ls", "cat"],
      });

      const result = await executeJustBash(projectRoot, "rm -rf /");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Command "rm" is not in the allowed list');
    });

    test("applies command allowlist after shell cwd prefix", async () => {
      await initShell({
        projectRoot,
        allowedCommands: ["pwd"],
      });
      const shell = createShellFunction(projectRoot);

      const result = await shell({ command: "pwd", cwd: "/workspace" });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    test("truncates large output and stores full stdout in /tmp", async () => {
      await initShell({ projectRoot, maxOutputBytes: 8 });

      const result = await executeJustBash(projectRoot, "printf abcdefghijklmnop");

      expect(result.stdout).toContain("ijklmnop");
      expect(result.stdout).toContain("Output truncated");
      expect(result.stdoutFile).toMatch(/^\/tmp\/codemode-shell-output-/);

      const saved = await executeJustBash(projectRoot, `cat ${result.stdoutFile}`, {
        maxOutputBytes: 100,
      });
      expect(saved.stdout).toBe("abcdefghijklmnop");
    });

    test("times out long-running commands", async () => {
      await initShell({ projectRoot });

      const result = await executeJustBash(projectRoot, "sleep 10", { timeoutMs: 100 });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("timed out");
    });
  });

  describe("createShellTag", () => {
    test("creates a tagged template function", async () => {
      await initShell({ projectRoot });
      const $ = createShellTag(projectRoot);

      // Returns a function that accepts template literal
      expect(typeof $).toBe("function");
    });

    test("quotes string interpolations safely", async () => {
      await initShell({ projectRoot });
      const $ = createShellTag(projectRoot);
      const unsafe = "world'; echo pwned; echo 'still data";

      const result = await $`printf %s ${unsafe}`;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(unsafe);
    });
  });

  describe("createShellFunction", () => {
    test("creates a shell function", async () => {
      await initShell({ projectRoot });
      const shell = createShellFunction(projectRoot);

      expect(typeof shell).toBe("function");
    });

    test("rejects invalid cwd paths", async () => {
      await initShell({ projectRoot });
      const shell = createShellFunction(projectRoot);

      const result = await shell({ command: "ls", cwd: "/etc" });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid cwd");
    });

    test("rejects cwd outside allowed mounts", async () => {
      await initShell({ projectRoot });
      const shell = createShellFunction(projectRoot);

      const result = await shell({ command: "ls", cwd: "/workspace/../../../etc" });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid cwd");
    });

    test("rejects relative cwd traversal outside workspace", async () => {
      await initShell({ projectRoot });
      const shell = createShellFunction(projectRoot);

      const result = await shell({ command: "ls", cwd: "../../../etc" });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid cwd");
    });

    test("keeps workspace symlinks scoped by ReadWriteFs", async () => {
      const scopedRoot = mkdtempSync(join(tmpdir(), "codemode-shell-scope-"));
      const outsideRoot = mkdtempSync(join(tmpdir(), "codemode-shell-outside-"));
      writeFileSync(join(outsideRoot, "secret.txt"), "host secret");
      symlinkSync(join(outsideRoot, "secret.txt"), join(scopedRoot, "secret-link.txt"));
      await initShell({ projectRoot: scopedRoot });

      const result = await executeJustBash(scopedRoot, "cat secret-link.txt");

      expect(result.stdout).not.toContain("host secret");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("generateShellTypeDefs", () => {
    test("includes ShellResult interface", () => {
      const types = generateShellTypeDefs();

      expect(types).toContain("interface ShellResult");
      expect(types).toContain("stdout: string");
      expect(types).toContain("stderr: string");
      expect(types).toContain("exitCode: number");
    });

    test("includes $ function declaration", () => {
      const types = generateShellTypeDefs();

      expect(types).toContain("declare function $(");
      expect(types).toContain("TemplateStringsArray");
    });

    test("includes shell function declaration", () => {
      const types = generateShellTypeDefs();

      expect(types).toContain("declare function shell(");
      expect(types).toContain("command: string");
      expect(types).toContain("cwd?: string");
      expect(types).toContain("timeoutMs?: number");
    });
  });

  describe("disposeShell", () => {
    test("cleans up shell context", async () => {
      await initShell({ projectRoot });
      await disposeShell(projectRoot);

      // After disposal, commands should fail
      await expect(executeJustBash(projectRoot, "echo hello")).rejects.toThrow(
        "Shell not initialized",
      );
    });
  });
});
