import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type PackageJson = {
  name?: string;
  main?: string;
  exports?: Record<string, unknown> | string;
  files?: string[];
  scripts?: Record<string, string>;
  keywords?: string[];
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
    expect(pkg.files).toEqual(["dist/", "README.md", "LICENSE"]);
    expect(pkg.files).not.toContain("src/");
  });

  test("attributes the package to boozedog and credits upstream Codemode/Pi work", () => {
    const pkg = packageJson() as PackageJson & {
      author?: string | { name?: string };
      contributors?: Array<string | { name?: string }>;
    };
    const author = typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "");
    expect(author.toLowerCase()).toContain("boozedog");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toMatch(/boozedog/i);
    expect(readme).toMatch(/Mario Zechner|Cloudflare Codemode|pi-coding-agent/i);
  });

  test("builds before npm pack; prepare only rebuilds for git/source installs", () => {
    const pkg = packageJson();

    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.scripts?.prepare).toBe("node ./scripts/prepare.mjs");
    const prepare = readFileSync(join(process.cwd(), "scripts", "prepare.mjs"), "utf8");
    expect(prepare).toContain(".git");
    expect(prepare).toContain("dist");
    expect(prepare).toContain("run");
    expect(prepare).toContain("build");
    expect(prepare).toMatch(/hasGit|\.git/);
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

  test("provides an npm publish helper for Pi package catalog discovery", () => {
    const pkg = packageJson();

    expect(pkg.keywords).toEqual(expect.arrayContaining(["pi-package"]));
    expect(pkg.scripts?.["publish:npm"]).toBe(
      "npm run check && npm run check:clean-tree && npm pack --dry-run && npm publish --access public",
    );
  });

  test("keeps runtime imports installable and Pi APIs as peers", () => {
    const pkg = packageJson();

    expect(pkg.dependencies).toEqual(
      expect.objectContaining({
        minisearch: expect.any(String),
        "pi-mcp-adapter": expect.any(String),
        "@jitl/quickjs-singlefile-mjs-release-sync": expect.any(String),
        "quickjs-emscripten-core": expect.any(String),
        typescript: expect.any(String),
      }),
    );
    expect(pkg.dependencies?.["pi-mcp-adapter"]).toBe("2.5.4");
    expect(pkg.devDependencies).not.toHaveProperty("typescript");
    expect(pkg.peerDependencies).toEqual(
      expect.objectContaining({
        "@mariozechner/pi-agent-core": "^0.73.1",
        "@mariozechner/pi-coding-agent": "^0.73.1",
        "@mariozechner/pi-tui": "^0.73.1",
      }),
    );
    for (const range of Object.values(pkg.peerDependencies ?? {})) {
      expect(range).not.toBe("*");
    }
  });
});

describe("tag-based distribution docs", () => {
  test("documents GitHub tag installs as the primary Pi extension path", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Alternative install: tagged GitHub release");
    expect(readme).toContain("pi install git:github.com/boozedog/pi-codemode@<tag>");
    expect(readme).toContain("pi -e git:github.com/boozedog/pi-codemode@<tag>");
    expect(readme).not.toMatch(/git:github\.com\/boozedog\/pi-codemode@v\d+\.\d+\.\d+/);
    expect(readme).toContain("pi update git:github.com/boozedog/pi-codemode");
    expect(readme).toContain("npm run release -- --version 0.1.3");
    expect(readme).toContain("npm run release");
    expect(readme).toContain("v$npm_package_version");
  });

  test("documents npm publishing for pi.dev package catalog discovery", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Publish to npm for pi.dev catalog discovery");
    expect(readme).toContain("npm run publish:npm");
    expect(readme).toContain("pi-package");
    expect(readme).toContain("pi install npm:@boozedog/pi-codemode");
  });

  test("documents the dependency pinning policy", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Dependency policy");
    expect(readme).toContain("pi-mcp-adapter");
    expect(readme).toContain("2.5.4");
    expect(readme).toContain("#31");
    expect(readme).toMatch(/host-coupled/i);
  });
});

describe("project-local Pi config hygiene", () => {
  test("does not track or publish project-local .pi config", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.pi\//m);

    const tracked = execFileSync("git", ["ls-files", ".pi", ".pi/codemode.json"], {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
    expect(tracked).toBe("");

    const pack = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    // npm pack --json prints a JSON array; paths live in filename lists depending on npm version
    expect(pack).not.toMatch(/\.pi\//);
    expect(pack).not.toContain("codemode.json");
  });

  test("ships a host-only examples/codemode.json without personal MCP servers", () => {
    const examplePath = join(process.cwd(), "examples", "codemode.json");
    expect(existsSync(examplePath)).toBe(true);
    const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
      mcp?: unknown;
      cli?: Record<string, { backend?: string; operations?: string[] }>;
    };

    expect(example.mcp).toBeUndefined();
    expect(example.cli).toBeTruthy();
    for (const [name, tool] of Object.entries(example.cli ?? {})) {
      expect({ tool: name, backend: tool.backend }).toEqual({ tool: name, backend: "host" });
    }
    expect(example.cli?.gh?.operations).toEqual(
      expect.arrayContaining([
        "issueListBlockedBy",
        "issueAddBlockedBy",
        "issueRemoveBlockedBy",
        "issueListBlocking",
      ]),
    );
    expect(example.cli?.find?.backend).toBe("host");
    expect(JSON.stringify(example)).not.toContain("just-bash");
    expect(JSON.stringify(example)).not.toContain("chrome-devtools");
    expect(JSON.stringify(example)).not.toContain("sfw");
  });
});
