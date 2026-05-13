import { describe, expect, test } from "vitest";
import { planNpmScript } from "./npm-scripts.js";

describe("npm script decomposition", () => {
  test("decomposes tsc build into a surfaced cli call", () => {
    expect(planNpmScript({ build: "tsc" }, "build")).toEqual({
      script: "build",
      calls: [{ tool: "tsc", operation: "build", args: {} }],
    });
  });

  test("decomposes tsc watch into an explicit watch argument", () => {
    expect(planNpmScript({ dev: "tsc --watch" }, "dev").calls).toEqual([
      { tool: "tsc", operation: "build", args: { watch: true } },
    ]);
  });

  test("recursively resolves npm run references", () => {
    const scripts = {
      check: "npm run build && npm test",
      build: "tsc",
      test: "vitest run",
    };

    expect(planNpmScript(scripts, "check").calls).toEqual([
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ]);
  });

  test("decomposes this repo's check script into surfaced cli calls", () => {
    const scripts = {
      check: "npm run format:check && npm run lint && npm run build && npm test",
      "format:check": "oxfmt . --check",
      lint: "oxlint --deny warnings --vitest-plugin src",
      build: "tsc",
      test: "vitest run",
    };

    expect(planNpmScript(scripts, "check").calls).toEqual([
      { tool: "oxfmt", operation: "check", args: { paths: ["."] } },
      {
        tool: "oxlint",
        operation: "run",
        args: { deny: "warnings", vitestPlugin: true, paths: ["src"] },
      },
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ]);
  });

  test("decomposes explicit vp fmt modes into surfaced cli calls", () => {
    expect(planNpmScript({ format: "vp fmt . --write" }, "format").calls).toEqual([
      { tool: "vp", operation: "fmtWrite", args: { paths: ["."] } },
    ]);
    expect(
      planNpmScript(
        { "format:check": "vp fmt src --check --ignore-path .gitignore --threads 4" },
        "format:check",
      ).calls,
    ).toEqual([
      {
        tool: "vp",
        operation: "fmtCheck",
        args: { paths: ["src"], ignorePath: ".gitignore", threads: 4 },
      },
    ]);
  });

  test("rejects ambiguous vp fmt without an explicit check or write mode", () => {
    expect(() => planNpmScript({ format: "vp fmt" }, "format")).toThrow(
      "vp fmt requires exactly one of --check or --write",
    );
  });

  test("fails loudly for denied commands with the script chain", () => {
    expect(() =>
      planNpmScript({ build: "npm run inner", inner: "node scripts/build.js" }, "build"),
    ).toThrow(
      "Refusing to decompose npm script 'inner' (chain: build -> inner): command 'node' is denied",
    );
  });

  test("rejects shell constructs outside the safe subset", () => {
    expect(() => planNpmScript({ build: "tsc | tee out.log" }, "build")).toThrow(
      "unsupported shell construct '|'",
    );
  });

  test("detects recursive npm script cycles", () => {
    expect(() => planNpmScript({ a: "npm run b", b: "npm run a" }, "a")).toThrow(
      "cycle detected while resolving npm scripts: a -> b -> a",
    );
  });

  test("rejects publish scripts with env expansion before execution", () => {
    expect(() =>
      planNpmScript(
        {
          "publish:tag":
            "npm run check && npm pack --dry-run && git tag v$npm_package_version && git push origin v$npm_package_version",
          check: "tsc",
        },
        "publish:tag",
      ),
    ).toThrow("unsupported shell construct '$'");
  });

  test("rejects clean-tree shell control flow before execution", () => {
    expect(() =>
      planNpmScript(
        {
          "check:clean-tree":
            "git diff --quiet && git diff --cached --quiet || (echo dirty && exit 1)",
        },
        "check:clean-tree",
      ),
    ).toThrow("unsupported shell construct '|'");
  });
});
