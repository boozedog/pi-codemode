import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type PackageJson = {
  name?: string;
  main?: string;
  exports?: Record<string, unknown> | string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
};

function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

describe("package metadata", () => {
  test("declares a portable Pi extension entrypoint built into dist", () => {
    const pkg = packageJson();

    expect(pkg.name).toBe("@boozedog/pi-codemode");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.exports).toEqual({ ".": "./dist/index.js" });
    expect(pkg.pi?.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "README.md", "LICENSE"]));
  });

  test("builds before npm pack and git installs", () => {
    const pkg = packageJson();

    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.scripts?.prepare).toBe("npm run build");
  });

  test("provides a release helper and tag-based publish script", () => {
    const pkg = packageJson();

    expect(pkg.scripts?.release).toBe("./scripts/release.sh");
    expect(pkg.scripts?.["publish:tag"]).toBe(
      "npm run check && npm run check:clean-tree && npm pack --dry-run && git tag v$npm_package_version && git push origin v$npm_package_version",
    );
    expect(pkg.scripts?.["check:clean-tree"]).toContain("Working tree is dirty");
    expect(pkg.scripts?.["check:clean-tree"]).toContain("git status --short");
  });

  test("keeps runtime imports installable and Pi APIs as peers", () => {
    const pkg = packageJson();

    expect(pkg.dependencies).toEqual(
      expect.objectContaining({
        "just-bash": expect.any(String),
        minisearch: expect.any(String),
        "pi-mcp-adapter": expect.any(String),
        "quickjs-emscripten": expect.any(String),
        typescript: expect.any(String),
      }),
    );
    expect(pkg.devDependencies).not.toHaveProperty("typescript");
    expect(pkg.peerDependencies).toEqual(
      expect.objectContaining({
        "@mariozechner/pi-agent-core": "*",
        "@mariozechner/pi-coding-agent": "*",
        "@mariozechner/pi-tui": "*",
      }),
    );
  });
});

describe("tag-based distribution docs", () => {
  test("documents GitHub tag installs as the primary Pi extension path", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Recommended install: tagged GitHub release");
    expect(readme).toContain("pi install git:github.com/boozedog/pi-codemode@<tag>");
    expect(readme).toContain("pi -e git:github.com/boozedog/pi-codemode@<tag>");
    expect(readme).not.toMatch(/git:github\.com\/boozedog\/pi-codemode@v\d+\.\d+\.\d+/);
    expect(readme).toContain("pi update git:github.com/boozedog/pi-codemode");
    expect(readme).toContain("npm run release -- --version 0.1.3");
    expect(readme).toContain("npm run release");
    expect(readme).toContain("v$npm_package_version");
  });
});
