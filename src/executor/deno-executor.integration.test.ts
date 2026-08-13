// deno-executor.integration.test.ts — Real-Deno integration tests.
//
// These tests require a `deno` binary on PATH. They are skipped when Deno is
// not installed, which is the case in the current development environment.
//
// ENVIRONMENT LIMITATION: the `--allow-read=` bootstrap-entrypoint finding
// (Deno needs read access to load the main module) cannot be exercised here
// because Deno is not installed. The fix grants read access ONLY to the
// generated bootstrap file (`--allow-read=<bootstrapPath>`) while keeping the
// rest of the filesystem denied. When Deno is available, the first test below
// verifies the bootstrap loads and a successful execution resolves; the
// permission tests verify guest filesystem/network/env access stays denied.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { DenoExecutor } from "./deno-executor.js";

function isDenoAvailable(): boolean {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const denoAvailable = isDenoAvailable();

describe.skipIf(!denoAvailable)("DenoExecutor integration (requires Deno)", () => {
  test("resolves a successful execution (bootstrap loads with --allow-read=<bootstrap>)", async () => {
    const executor = new DenoExecutor({ timeout: 10_000 });
    const result = await executor.execute(
      "return { ok: true, name: π.name, date: args.date };",
      [{ name: "codemode", fns: {} }],
      { strings: { name: "deno" }, args: { date: "2026-08-13" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ ok: true, name: "deno", date: "2026-08-13" });
    await executor.shutdown();
  });

  test("denies guest filesystem, network, env, subprocess, system, and FFI access", async () => {
    const executor = new DenoExecutor({ timeout: 10_000 });
    const result = await executor.execute(
      `
        const out = {};
        try { await Deno.readTextFile("/etc/hostname"); out.read = "ok"; }
        catch { out.read = "denied"; }
        try { await fetch("https://example.com"); out.net = "ok"; }
        catch { out.net = "denied"; }
        try { out.env = Deno.env.get("HOME"); }
        catch { out.env = "denied"; }
        try { await new Deno.Command("echo", { args: ["hi"] }).output(); out.run = "ok"; }
        catch { out.run = "denied"; }
        try { Deno.systemMemoryInfo(); out.sys = "ok"; }
        catch { out.sys = "denied"; }
        try { Deno.dlopen("/lib/libc.so.6", {}); out.ffi = "ok"; }
        catch { out.ffi = "denied"; }
        return out;
      `,
      [{ name: "codemode", fns: {} }],
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      read: "denied",
      net: "denied",
      env: "denied",
      run: "denied",
      sys: "denied",
      ffi: "denied",
    });
    await executor.shutdown();
  });

  test("terminates runaway code via the parent hard timeout", async () => {
    const executor = new DenoExecutor({ timeout: 200 });
    const result = await executor.execute("while (true) {}", [{ name: "codemode", fns: {} }]);
    expect(result.error).toMatch(/timed out/i);
    await executor.shutdown();
  });
});
