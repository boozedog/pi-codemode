# Pi Codemode

Pi Codemode is a Pi extension that replaces many small tool calls with one typed `execute_tools` call. The model writes a TypeScript code body, Pi type-checks it, then runs it in a sandbox with explicit tool globals.

## Quickstart

Install the package in Pi as an extension package, then start Pi in a project as usual. Codemode starts in configured mode; the default is `on`, which exposes `execute_tools` plus Pi's normal non-bash tools.

Useful controls:

- `/codemode on` exposes `execute_tools` plus normal non-bash tools, write-locked to the project root.
- `/codemode yolo` exposes everything from `on` plus native `bash` when available (the write escape hatch).
- `/codemode off` restores normal Pi tools, including native `write`/`edit`/`bash`.
- Bare `/codemode` toggles `off <-> on`.

### Running jobs with arguments

Run a skill or TypeScript entry without a model turn. The job name and arguments are
one string; quote the `--run` value when it contains arguments:

```bash
pi -p --run 'daily-mail date=2026-08-10'
pi -p --run 'daily-mail --date 2026-08-10 --verbose'
pi -p --run 'daily-mail --date=2026-08-10'
pi -p --run daily-mail
```

`-p --run` is also the primary preflight-and-handoff workflow. A skill can opt in by
setting `handoff: true` in its `SKILL.md` frontmatter. Its markdown body is sent to
the normal model turn after the off-model entry completes. Use `{{result}}` for the
serialized return value, `{{result.json}}` for JSON, and `{{args}}` for the parsed
arguments. In this mode stdout contains the final assistant text and the process
waits for that turn; a non-zero exit means either preflight or the model turn failed.
Skills without `handoff: true` retain the pure off-model contract: stdout is the
serialized return value and `-p` exits after the job. `/run` uses the same semantics
inside the TUI. Prefer only `--run` for handoff invocations; combining it with extra
bare `pi -p "prompt"` arguments is discouraged and has undefined ordering.

The interactive command uses the same grammar: `/run daily-mail --date 2026-08-10`.
Jobs read values from `args`, for example `args.date` (missing keys are `undefined`):

```ts
const date = args.date ?? new Date().toISOString().slice(0, 10);
return { date };
```

Supported forms are `key=value`, `--key=value`, `--key value`, and bare `--flag`
(which gives `"true"`). Values are strings. Pi does not support sibling flags after
`--run`: `pi -p --run daily-mail --date 2026-08-10` is rejected as an unknown Pi
option. Put all arguments inside the single quoted `--run` string instead.

### Write-door matrix

`on` mode is **write-locked**: native write-capable tools (`write`, `edit`, `bash`) are stripped from the active set. The only write doors are the root-scoped patch tools and allowlisted `cli.*` operations.

| Door                                                       | `on`            | `yolo`                   |
| ---------------------------------------------------------- | --------------- | ------------------------ |
| codemode guest (in-guest `read` only; no mutation helpers) | read-only       | read-only                |
| patch tools `replace_in_file` / `apply_patch`              | **root-scoped** | **unrestricted**         |
| native `write`                                             | **DENY**        | **DENY**                 |
| native `edit`                                              | **DENY**        | **DENY**                 |
| native `bash`                                              | **DENY**        | **ALLOW** (escape hatch) |
| host `cli.*`                                               | allowlisted ops | allowlisted ops          |

## The `execute_tools` shape

`execute_tools` accepts a TypeScript **code body**, not a full function:

```ts
const pkg = await read({ path: "package.json" });
print("package bytes", pkg.length);
return JSON.parse(pkg).name;
```

Return a value to include it in the tool result. `print()` and `console.log()` output is captured before the return value. Type errors are reported before execution, so invalid code has no side effects. Runtime errors are returned as tool errors.

Large codemode calls, results, and file diffs render compactly in Pi by hiding their middle section. Use `Ctrl+O` to expand the hidden content, and `Ctrl+O` again to collapse.

## Built-in globals

Generated code only receives explicit globals:

- `read({ path, offset?, limit? })` reads a project file.
- `write({ path, content })` writes a project file, creating parent directories.
- `edit({ path, edits })` performs exact text replacements.
- `codemode.search_tools({ query })` searches available Pi/MCP tools.
- `codemode.list_mcp_servers()` lists configured MCP namespaces.
- `codemode.list_tools({ namespace, offset?, limit? })` lists cached MCP tools with pagination.
- `codemode.describe_tools({ namespace, tool? })` shows MCP namespace/tool details.
- `codemode.plan_npm_script({ script })` decomposes a safe package script into visible `cli.*` calls without executing it.
- `codemode.run_npm_script({ script, verbose? })` decomposes a safe package script, shows the plan, and executes only the surfaced `cli.*` calls.
- `mcp.<namespace>.<tool>(args)` calls configured MCP tools. The legacy `codemode.<namespace>.<tool>(args)` form remains supported.
- `cli.<tool>.<operation>(args)` calls configured typed CLI capabilities.
- `print(...args)` emits result output.
- `π.key` reads string constants passed in the `strings` parameter.

### File edits

`edit` mirrors Pi's exact replacement model:

```ts
await edit({
  path: "src/index.ts",
  edits: [{ oldText: "const oldName =", newText: "const newName =" }],
});
```

Each `oldText` must match exactly once in the original file. Edits in one call must not overlap. Merge nearby changes into one larger replacement.

### Hard-to-quote strings with `π`

Use `strings` for file content that contains backticks, `${...}`, nested quotes, code blocks, or shell scripts:

```json
{
  "code": "await write({ path: 'script.sh', content: π.script });",
  "strings": {
    "script": "#!/usr/bin/env bash\necho \"hello ${USER}\"\n"
  }
}
```

Inside code, `π.script` is a normal string. The `strings` values only need JSON escaping, not JavaScript string-literal escaping.

### Parallel calls

Use `Promise.all` for independent work:

```ts
const [pkg, tsconfig, readme] = await Promise.all([
  read({ path: "package.json" }),
  read({ path: "tsconfig.json" }),
  read({ path: "README.md" }),
]);
return { files: [pkg.length, tsconfig.length, readme.length] };
```

## CLI capabilities

Codemode does not expose a shell-string API. There is no `$`, `shell()`, `bash -c`, or raw argv passthrough in generated code. Instead, configured typed command capabilities are exposed under `cli`:

```ts
const status = await cli.git.status({ short: true, branch: true });
const hits = await cli.rg.search({ pattern: "TODO", paths: ["src"], lineNumber: true });
```

Each `cli` tool/operation must be allowlisted in config and runs as a native host command (`backend: "host"`). There is no in-guest shell backend. Discovery never auto-exposes host binaries; only configured operations are available.

Host command output is capped inline at 50 KiB per stream, with a truncation marker when exceeded. Non-zero command exits do not throw; inspect `exitCode`. Denied operations, missing executables, timeouts, and invalid runtime argument shapes throw clear CLI errors.

GitHub issue relationship operations are intentionally curated. Codemode exposes narrow helpers matching GitHub's first-class issue dependency endpoint names: `cli.gh.issueListBlockedBy()`, `cli.gh.issueAddBlockedBy()`, and `cli.gh.issueListBlocking()`. These are backed by `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` and `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking`. Codemode does not expose generic `gh api` or arbitrary GraphQL execution to generated code; host code constructs the exact endpoint and resolves blocking issue numbers to same-repository REST database IDs internally.

### npm script decomposition

Codemode treats npm scripts as recipes to inspect, not shell commands to execute. Generated code should not call `npm`, `npx`, `node`, `bash`, or other abstraction layers directly. Instead, use the codemode npm-script helpers:

```ts
return await codemode.plan_npm_script({ script: "build" });
```

For a package script such as:

```json
{
  "scripts": {
    "build": "tsc",
    "check": "npm run format:check && npm run lint && npm run build && npm test",
    "format:check": "oxfmt . --check",
    "lint": "oxlint --deny warnings --vitest-plugin src",
    "test": "vitest run"
  }
}
```

the plan is surfaced as explicit calls:

```text
Plan for npm run check:
- cli.oxfmt.check({"paths":["."]})
- cli.oxlint.run({"deny":"warnings","vitestPlugin":true,"paths":["src"]})
- cli.tsc.build({})
- cli.vitest.run({})

No commands were executed.
```

To run the safe plan:

```ts
return await codemode.run_npm_script({ script: "check" });
```

`run_npm_script` prints the plan, executes only the surfaced `cli.*` calls, and stops on the first non-zero exit. By default, successful step output is compact; pass `verbose: true` to include stdout/stderr from successful steps:

```ts
return await codemode.run_npm_script({ script: "check", verbose: true });
```

Scripts fail loudly before execution if they contain unsupported shell constructs, env expansion, command substitution, pipes/redirection, recursive cycles, or denied commands such as `node`, `npm`, `npx`, `bash`, or `python` outside the safe recursive `npm run <script>` / `npm test` subset.

Operation-specific timeouts can be configured with object-form `operations`:

```json
{
  "cli": {
    "rg": {
      "backend": "host",
      "operations": {
        "search": { "timeoutMs": 5000 }
      }
    }
  }
}
```

## MCP discovery workflow

MCP tools are exposed under the preferred `mcp.*` namespace. The legacy `codemode.<namespace>.<tool>()` form remains supported:

```ts
const github = await codemode.describe_tools({ namespace: "github" });
print(github);

const details = await codemode.describe_tools({ namespace: "github", tool: "search_issues" });
print(details);

return await mcp.github.search_issues({ query: "is:open label:bug" });
```

Use `codemode.list_mcp_servers()` to see available namespaces and `codemode.list_tools({ namespace })` to page through large cached tool lists. Use `codemode.search_tools({ query })` when you do not know the namespace or exact tool name.

## Configuration

Codemode loads JSON config from:

1. `~/.pi/agent/codemode.json`
2. `$PROJECT/.pi/codemode.json`

Project config overrides global config. Copy `examples/codemode.json` to `~/.pi/agent/codemode.json` (global) or `$PROJECT/.pi/codemode.json` (project-local). Project `.pi/` is gitignored personal override space — do not commit it. The example is host-only `cli.*` with no personal MCP servers.

Default config:

```json
{
  "mode": "on",
  "executor": {
    "type": "quickjs",
    "timeoutMs": 120000
  }
}
```

`mode` can be `"on"`, `"yolo"`, or `"off"`. In `on`, Codemode exposes `execute_tools` plus normal non-bash tools, write-locked to the project root (native `write`/`edit`/`bash` are stripped; writes go through the root-scoped patch tools or allowlisted `cli.*`). In `yolo`, native `bash` is included if Pi provides it; if not, codemode gracefully falls back to normal codemode tools and notifies you. In `off`, normal Pi tools (including native `write`/`edit`/`bash`) are restored.

Codemode-specific MCP servers and typed CLI capabilities can also be configured here:

```json
{
  "mcp": {
    "servers": {
      "github-mcp": { "command": "github-mcp" }
    }
  },
  "cli": {
    "git": {
      "backend": "host",
      "operations": [
        "status",
        "branch",
        "diff",
        "log",
        "show",
        "remote",
        "revParse",
        "add",
        "commit",
        "push",
        "pull",
        "switch",
        "checkout",
        "restore",
        "reset",
        "stash",
        "tag"
      ]
    },
    "gh": {
      "backend": "host",
      "operations": [
        "issueView",
        "issueList",
        "issueCreate",
        "issueEdit",
        "issueComment",
        "issueClose",
        "labelCreate",
        "labelList",
        "prView",
        "prList",
        "prDiff",
        "prChecks",
        "prStatus"
      ]
    },
    "rg": { "backend": "host", "operations": ["search"] },
    "find": { "backend": "host", "operations": ["files"] },
    "grep": { "backend": "host", "operations": ["search"] },
    "ls": { "backend": "host", "operations": ["list"] },
    "vitest": { "backend": "host", "operations": ["run"] },
    "tsc": { "backend": "host", "operations": ["build"] },
    "oxfmt": { "backend": "host", "operations": ["check", "write"] },
    "oxlint": { "backend": "host", "operations": ["run"] },
    "vp": { "backend": "host", "operations": ["fmtCheck", "fmtWrite"] }
  }
}
```

`quickjs` is the default MVP executor. `deno` is optional/future support behind the same executor interface; if selected and unavailable, `execute_tools` reports a configured-executor runtime error.

## Security model

Generated code is untrusted. The host dispatcher is the authority.

Denied by default:

- direct Node globals such as `process` and `require`
- direct filesystem access from generated code
- direct environment access
- direct network access
- subprocess spawning from generated code
- unrestricted host bash or shell strings inside generated code

In `yolo` mode, Pi's native `bash` tool is available outside `execute_tools` as an explicit escape hatch and has broader host access. Use `on` mode when you want Codemode without the native bash escape hatch.

- raw subprocess/argv passthrough from generated code

Allowed capabilities are only the injected globals listed above. File tools validate paths against the project root and reject traversal outside it. Enabling host-backed `cli` operations expands trust boundaries and should be reviewed in config.

## Attribution

Maintained and published by **boozedog** as `@boozedog/pi-codemode`.

This project builds on Pi coding-agent extension patterns and Codemode-style typed tool execution ideas associated with Mario Zechner's Pi ecosystem and Cloudflare Codemode. See repository history and upstream projects for lineage.

## Installation

### Recommended install: npm package

Pi Codemode is published as a Pi package on npm and is discoverable in the `pi.dev` package catalog because `package.json` includes the `pi-package` keyword and a Pi extension manifest.

```sh
pi install npm:@boozedog/pi-codemode
```

To try the npm package for one Pi run without adding it to settings:

```sh
pi -e npm:@boozedog/pi-codemode
```

### Alternative install: tagged GitHub release

Pi Codemode is distributed through normal Pi extension package installs using GitHub release tags. This does not require cloning this repository to a fixed local path:

```sh
pi install git:github.com/boozedog/pi-codemode@<tag>
```

To try a tagged release for one Pi run without adding it to settings:

```sh
pi -e git:github.com/boozedog/pi-codemode@<tag>
```

For unpinned development installs from GitHub, update with:

```sh
pi update git:github.com/boozedog/pi-codemode
# or update all Pi extensions
pi update --extensions
```

For local development, keep using a path install from this checkout:

```sh
npm install
npm run build
pi install /absolute/path/to/pi-codemode
```

The package manifest points Pi at `./dist/index.js`. Runtime packages are normal `dependencies`; Pi-provided APIs are declared as `peerDependencies`. Git installs run `npm install`, and the package `prepare` script builds `dist/` after install. npm publishes run `prepack`, which also builds `dist/` before creating the tarball.

### Dependency policy

Host-coupled or deeply integrated dependencies are exact-pinned when a version change can alter runtime loading or integration behavior. Pure JavaScript libraries use caret ranges so compatible fixes can be installed. `pi-mcp-adapter` is intentionally pinned to `2.5.4` because newer releases currently break this package's deep adapter imports; see [#31](https://github.com/boozedog/pi-codemode/issues/31) before changing it. The Pi peer packages are currently constrained to `^0.73.1`, matching the APIs Codemode integrates with and the development `pi-tui` floor. The upstream ecosystem is also transitioning from `@mariozechner/pi-*` packages to `@earendil-works/*`; this package keeps its existing peer names until that migration is verified.

## Development

```sh
npm install
npm test
npm run build
npm run check
```

Inside Codemode itself, prefer the surfaced npm-script workflow instead of direct `npm run` execution:

```ts
await codemode.plan_npm_script({ script: "check" });
await codemode.run_npm_script({ script: "check" });
```

Source lives in `src/`; generated build output lives in `dist/`.

## Release checklist

To bump the version, run the release helper from a clean tree:

```sh
npm run release -- --version 0.1.3
```

To publish the current `package.json` version without bumping:

```sh
npm run release
```

The helper checks for a clean tree, updates `package.json`/`package-lock.json` when `--version` is provided, runs `npm run check`, commits the version bump, verifies package contents with `npm pack --dry-run`, then creates and pushes `v$npm_package_version`.

After the tag is pushed:

1. From a clean directory or machine, install the tag with `pi install git:github.com/boozedog/pi-codemode@<tag>`.
2. Start Pi and confirm Codemode loads, the `codemode` tool can read files, typed host `cli.*` capabilities work, and the result UI renders.
3. Publish the same version to npm for the Pi package catalog.

### Publish to npm for pi.dev catalog discovery

Make sure you are logged in to npm as an account with publish rights for `@boozedog/pi-codemode`, then run:

```sh
npm run publish:npm
```

The publish helper runs checks, verifies the tree is clean, dry-runs the package tarball, and publishes with `--access public`. Once npm indexes the package, `https://pi.dev/packages` discovers it from the `pi-package` keyword.
