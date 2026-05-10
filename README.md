# Pi Codemode

Pi Codemode is a Pi extension that replaces many small tool calls with one typed `execute_tools` call. The model writes a TypeScript code body, Pi type-checks it, then runs it in a sandbox with explicit tool globals.

## Quickstart

Install the package in Pi as an extension package, then start Pi in a project as usual. Codemode enables automatically and limits the active model-visible tool set to `execute_tools`.

Useful controls:

- `/codemode` toggles codemode on or off during a session.
- `--no-codemode` starts Pi with normal tools instead of `execute_tools`.

## The `execute_tools` shape

`execute_tools` accepts a TypeScript **code body**, not a full function:

```ts
const pkg = await read({ path: "package.json" });
print("package bytes", pkg.length);
return JSON.parse(pkg).name;
```

Return a value to include it in the tool result. `print()` and `console.log()` output is captured before the return value. Type errors are reported before execution, so invalid code has no side effects. Runtime errors are returned as tool errors.

## Built-in globals

Generated code only receives explicit globals:

- `read({ path, offset?, limit? })` reads a project file.
- `write({ path, content })` writes a project file, creating parent directories.
- `edit({ path, edits })` performs exact text replacements.
- `codemode.search_tools({ query })` searches available Pi/MCP tools.
- `codemode.describe_tools({ namespace, tool? })` shows MCP namespace/tool details.
- `codemode.<namespace>.<tool>(args)` calls configured MCP tools.
- `$\`command\`` runs a just-bash command.
- `shell({ command })` runs a just-bash command from a string.
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

## Shell support and limitations

`$` and `shell()` use `just-bash`; they are not unrestricted host bash. The shell sees scoped mounts, typically:

- `/workspace` mapped to the project root, read/write
- `/tmp` as temporary in-memory space
- optional in-memory home/reference mounts

Network is disabled by default. JavaScript/Python runtimes inside just-bash are disabled by default. Generated code has no direct host filesystem or subprocess access; shell workflows must go through `$` or `shell()`.

## MCP discovery workflow

MCP tools are exposed under `codemode.*` only:

```ts
const github = await codemode.describe_tools({ namespace: "github" });
print(github);

const details = await codemode.describe_tools({ namespace: "github", tool: "search_issues" });
print(details);

return await codemode.github.search_issues({ query: "is:open label:bug" });
```

Use `codemode.search_tools({ query })` when you do not know the namespace or exact tool name.

## Configuration

Codemode loads JSON config from:

1. `~/.pi/agent/codemode.json`
2. `$PROJECT/.pi/codemode.json`

Project config overrides global config.

Default config:

```json
{
  "executor": {
    "type": "quickjs",
    "timeoutMs": 120000
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
- unrestricted host bash
- just-bash network and JS/Python runtimes

Allowed capabilities are only the injected globals listed above. File tools validate paths against the project root and reject traversal outside it.

## Development

```sh
npm install
npm test
npm run build
npm run check
```

Source lives in `src/`; generated build output lives in `dist/`.
