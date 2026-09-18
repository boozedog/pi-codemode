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

  test("does not expose a local npm publish script", () => {
    const pkg = packageJson();

    expect(pkg.keywords).toEqual(expect.arrayContaining(["pi-package"]));
    expect(pkg.scripts?.["publish:npm"]).toBeUndefined();
  });

  test("pins lockfile generation to legacy-peer-deps so CI npm ci matches", () => {
    const npmrc = readFileSync(join(process.cwd(), ".npmrc"), "utf8");
    expect(npmrc).toMatch(/^legacy-peer-deps=true$/m);
  });

  test("uses an HTTPS repository URL for provenance source matching", () => {
    const pkg = packageJson() as PackageJson & { repository?: { url?: string } };

    expect(pkg.repository?.url).toBe("https://github.com/boozedog/pi-codemode.git");
  });

  test("keeps runtime imports installable and Pi APIs as peers", () => {
    const pkg = packageJson();

    expect(pkg.dependencies).toEqual(
      expect.objectContaining({
        minisearch: expect.any(String),
        "@modelcontextprotocol/client": expect.any(String),
        "@jitl/quickjs-singlefile-mjs-release-sync": expect.any(String),
        "quickjs-emscripten-core": expect.any(String),
        typescript: expect.any(String),
      }),
    );
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

  test("documents CI npm publishing for pi.dev package catalog discovery", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Publish to npm for pi.dev catalog discovery");
    expect(readme).not.toContain("npm run publish:npm");
    expect(readme).not.toMatch(/logged in to npm/i);
    expect(readme).toContain("publish.yml");
    expect(readme).toContain("trusted publish");
    expect(readme).toContain("npm stage publish");
    expect(readme).toContain("npm stage approve");
    expect(readme).toMatch(/stage-only|staged publishing/i);
    expect(readme).toContain("workflow_dispatch");
    expect(readme).toContain("pi-package");
    expect(readme).toContain("pi install npm:@boozedog/pi-codemode");
    expect(readme).toMatch(/disallow tokens/i);
    expect(readme).not.toMatch(/\bconsider\b.*disallow tokens/i);
    expect(readme).not.toMatch(/allowed actions: `npm publish`/);
  });

  test("documents the dependency pinning policy", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Dependency policy");
    expect(readme).toContain("@modelcontextprotocol/client");
    expect(readme).toContain("OAuth");
    expect(readme).toMatch(/host-coupled/i);
  });
});

describe("CI publish workflow", () => {
  const workflowPath = join(process.cwd(), ".github", "workflows", "publish.yml");

  test("exists at .github/workflows/publish.yml", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  test("triggers on v*.*.* tags and supports workflow_dispatch", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toMatch(/tags:\s*\n\s*-\s*["']v\*.\*.\*["']/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("inputs:");
    expect(workflow).toContain("tag:");
  });

  test("uses OIDC trusted publishing without long-lived npm tokens", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toMatch(/NPM_TOKEN/i);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN/i);
    expect(workflow).not.toContain("--provenance");
    expect(workflow).toContain("npm stage publish --access public");
    expect(workflow).not.toMatch(/^\s+- run: npm publish\b/m);
    expect(workflow).toContain("npm@^11.15.0");
    expect(workflow.indexOf("npm ci")).toBeLessThan(workflow.indexOf("npm@^11.15.0"));
    expect(workflow.indexOf("npm@^11.15.0")).toBeLessThan(workflow.indexOf("npm stage publish"));
    expect(workflow).toContain('registry-url: "https://registry.npmjs.org"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toMatch(/apt-get install[^\n]*ripgrep/);
  });

  test("uses setup-node v7 for OIDC trusted publishing with registry-url", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("actions/setup-node@v7");
    expect(workflow).not.toMatch(/actions\/setup-node@v6/);
  });

  test("scopes workflow permissions for fork safety", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("if: github.repository == 'boozedog/pi-codemode'");
  });

  test("validates dispatch tag format before writing workflow outputs", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    expect(workflow).toMatch(/invalid tag/i);
  });

  test("validates tag matches package.json version before publish", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toMatch(/Require tag to match package\.json version/i);
    expect(workflow).toMatch(/require\(['"]\.\/package\.json['"]\)\.version/);
    expect(workflow).toContain('test "$TAG" = "v$PKG"');
  });

  test("does not interpolate GitHub expressions inside run script text", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const runBlocks = [
      ...workflow.matchAll(/^\s+run:\s*\|\n([\s\S]*?)(?=^\S|\n\s+- |\n\s+uses:|\njobs:)/gm),
    ]
      .map((match) => match[1] ?? "")
      .map((block) => block.replace(/^ {10}/gm, ""));

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
      expect(block).not.toMatch(/\$\{\{\s*steps\./);
    }
  });

  test("resolves dispatch and tag-push tags via env before bash assignment", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toMatch(
      /name: Resolve tag[\s\S]*?env:\s*\n\s*EVENT_NAME:\s*\$\{\{ github\.event_name \}\}/,
    );
    expect(workflow).toMatch(/INPUT_TAG:\s*\$\{\{ inputs\.tag \}\}/);
    expect(workflow).toMatch(/REF_NAME:\s*\$\{\{ github\.ref_name \}\}/);
    expect(workflow).toContain('if [ "$EVENT_NAME" = "workflow_dispatch" ]; then');
    expect(workflow).toContain('TAG="$INPUT_TAG"');
    expect(workflow).toContain('TAG="$REF_NAME"');
  });

  test("passes resolved tag name through env for version match step", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toMatch(
      /Require tag to match package\.json version[\s\S]*?env:\s*\n\s*TAG_NAME:\s*\$\{\{ steps\.tag\.outputs\.name \}\}/,
    );
    expect(workflow).toMatch(/TAG="\$TAG_NAME"/);
    expect(workflow).not.toMatch(/TAG="\$\{\{ steps\.tag\.outputs\.name \}\}"/);
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
