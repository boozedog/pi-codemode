# Pi Codemode

Pi Codemode is a Pi extension that replaces many small tool calls with one typed `execute_tools` call. The model writes a TypeScript code body, Pi type-checks it, then runs it in a sandbox with explicit tool globals.

## Quickstart

Install the package in Pi as an extension package, then start Pi in a project as usual. Codemode starts in configured mode; the default is `on`, which exposes `execute_tools` plus Pi's normal non-bash tools.

Useful controls:

- `/codemode on` exposes `execute_tools` plus normal non-bash tools.
- `/codemode yolo` exposes everything from `on` plus native `bash` when available.
- `/codemode off` restores normal Pi tools.
- Bare `/codemode` toggles `off <-> on`.

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
- `codemode.<namespace>.<tool>(args)` calls configured MCP tools.
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

Each `cli` tool/operation must be allowlisted in config. Backends may be native host commands or `just-bash` commands. `just-bash` backend operations are explicitly limited to read-only operation metadata and must exist in the installed `just-bash` command set; discovery is used for validation only and never auto-exposes commands. `just-bash` still uses scoped mounts internally, typically `/workspace` mapped to the project root read/write and `/tmp` as in-memory temp space. Network and JS/Python runtimes remain disabled by default.

Host command output is capped inline at 50 KiB per stream, with a truncation marker when exceeded. Non-zero command exits do not throw; inspect `exitCode`. Denied operations, missing executables, timeouts, and invalid runtime argument shapes throw clear CLI errors.

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

MCP tools are exposed under `codemode.*` only:

```ts
const github = await codemode.describe_tools({ namespace: "github" });
print(github);

const details = await codemode.describe_tools({ namespace: "github", tool: "search_issues" });
print(details);

return await codemode.github.search_issues({ query: "is:open label:bug" });
```

Use `codemode.list_mcp_servers()` to see available namespaces and `codemode.list_tools({ namespace })` to page through large cached tool lists. Use `codemode.search_tools({ query })` when you do not know the namespace or exact tool name.

## Configuration

Codemode loads JSON config from:

1. `~/.pi/agent/codemode.json`
2. `$PROJECT/.pi/codemode.json`

Project config overrides global config. See `examples/codemode.json` for a starter configuration with typed `git`, `gh`, `rg`, `find`, `grep`, and `ls` capabilities.

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

`mode` can be `"on"`, `"yolo"`, or `"off"`. In `on`, Codemode exposes `execute_tools` plus normal non-bash tools. In `yolo`, native `bash` is included if Pi provides it; if not, codemode gracefully falls back to normal codemode tools and notifies you.

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
    "find": { "backend": "just-bash", "operations": ["files"] },
    "grep": { "backend": "just-bash", "operations": ["search"] },
    "ls": { "backend": "just-bash", "operations": ["list"] },
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
- just-bash network and JS/Python runtimes

Allowed capabilities are only the injected globals listed above. File tools validate paths against the project root and reject traversal outside it. Enabling host-backed `cli` operations expands trust boundaries and should be reviewed in config.

## Installation

### Recommended install: tagged GitHub release

Pi Codemode is distributed through normal Pi extension package installs using GitHub release tags. This does not require cloning this repository to a fixed local path:

```sh
pi install git:github.com/boozedog/pi-codemode@v0.1.1
```

To try a tagged release for one Pi run without adding it to settings:

```sh
pi -e git:github.com/boozedog/pi-codemode@v0.1.1
```

For unpinned development installs from GitHub, update with:

```sh
pi update git:github.com/boozedog/pi-codemode
# or update all Pi extensions
pi update --extensions
```

An npm package can be added later if needed:

```sh
pi install npm:@boozedog/pi-codemode
pi -e npm:@boozedog/pi-codemode
```

For local development, keep using a path install from this checkout:

```sh
npm install
npm run build
pi install /absolute/path/to/pi-codemode
```

The package manifest points Pi at `./dist/index.js`. Runtime packages are normal `dependencies`; Pi-provided APIs are declared as `peerDependencies`. Git installs run `npm install`, and the package `prepare` script builds `dist/` after install. npm publishes run `prepack`, which also builds `dist/` before creating the tarball.

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

1. Run `npm run check`.
2. Confirm package contents with `npm pack --dry-run`; the tarball should include `dist/index.js`, `README.md`, `LICENSE`, and `package.json`.
3. Create and push the version tag with the npm script:

   ```sh
   npm run publish:tag
   ```

   The script runs checks, fails if the git working tree has unstaged or staged changes, verifies package contents with `npm pack --dry-run`, then creates and pushes `v$npm_package_version` (for example `v0.1.1`).

4. From a clean directory or machine, install the tag with `pi install git:github.com/boozedog/pi-codemode@<tag>`.
5. Start Pi and confirm Codemode loads, `execute_tools` can read files, typed CLI/shell capabilities work, and the result UI renders.
6. Optional later: publish the same version to npm with `npm publish --access public`.
