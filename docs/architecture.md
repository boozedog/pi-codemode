# Pi Codemode Architecture

## Vision

Pi Codemode exposes one primary Pi tool, `execute_tools`, where the model writes TypeScript code to orchestrate multiple capabilities in one call:

- Pi-backed tools such as read/write/edit
- shell-like workflows through `just-bash`
- codemode-only MCP tools
- discovery helpers such as `search_tools` and `describe_tools`

The generated API exposes Pi-aligned top-level file helpers plus `codemode.*` for discovery and MCP namespaces:

```ts
const [pkg, readme] = await Promise.all([
  read({ path: "package.json" }),
  read({ path: "README.md" }),
]);

await edit({
  path: "src/index.ts",
  edits: [{ oldText: "exact unique original text", newText: "replacement" }],
});

const todos = await $`rg TODO src`;
return { pkg, readme, todos };
```

The codemode `edit` helper intentionally mirrors Pi's native exact-replacement schema. Each `oldText` must match exactly once in the original file, edits must not overlap, and nearby edits should be merged into one larger replacement. When codemode is disabled, the extension injects the same concise native `edit` guidance into the system prompt because Pi does not currently document an extension API for overriding built-in tool descriptions in place.

## Target stack

```txt
Pi plugin
  -> Cloudflare codemode core helpers where useful
  -> Pi-native execute_tools wrapper
  -> QuickJS sandbox executor
  -> async host-function bridge
  -> Pi safe tools + just-bash commands + codemode-only MCP
```

Deno remains an optional/future executor behind the same interface. Node VM is intentionally skipped for now.

## Executor choices

QuickJS is the default MVP executor (`executor.type: "quickjs"`). It runs code in an embedded QuickJS runtime with an explicit host bridge and no direct Node, filesystem, environment, network, or subprocess globals. Tool access is limited to injected globals (`codemode`, `$`, `shell`, `print`, and `π`).

Deno is still available as an optional executor (`executor.type: "deno"`) for future compatibility and experiments, but it is dormant unless selected in configuration. Configuration is loaded from `~/.pi/agent/codemode.json` and `$PROJECT/.pi/codemode.json`, with project settings taking precedence. When selected, Deno stays behind the shared executor interface and launches a no-permission subprocess. If the configured executable is missing or cannot be spawned, `execute_tools` reports a clear configured-executor-unavailable runtime error instead of silently falling back.

Node VM is not an MVP target and should not be added as an executor path.

## Cloudflare codemode findings

The project uses `@cloudflare/codemode` as reusable core, not as an AI SDK adapter.

Confirmed useful exports:

- `generateTypesFromJsonSchema(tools)`
  - JSON Schema -> TypeScript types
  - no AI SDK dependency
  - no Zod dependency
- `jsonSchemaToType(schema, typeName)`
  - individual schema conversion helper
- `sanitizeToolName(name)`
  - valid JavaScript identifier conversion
  - handles hyphens, dots, spaces, digit prefixes, and reserved words
- `normalizeCode(code)`
  - code normalization helper
- `Executor` interface
  - useful conceptual seam for pluggable executors

Cloudflare's `DynamicWorkerExecutor` is Cloudflare Workers-specific and is not a local Pi default.

## Executor strategy

### QuickJS — preferred MVP executor

Direct `quickjs-emscripten` integration is the preferred MVP executor direction.

Reasons:

- no external Deno binary dependency
- stronger isolation than Node `vm`
- in-process embedding keeps good ergonomics
- good package portability
- direct control over injected globals and async host bridge

The executor should:

1. host-side type-check user code
2. transform/strip TypeScript
3. evaluate JavaScript in QuickJS
4. inject globals:
   - `codemode`
   - `$`
   - `shell`
   - `print`
   - `π`
5. route all host capabilities through an async host-function bridge

The critical spike is high-concurrency async host calls:

```ts
const results = await Promise.all(Array.from({ length: 100 }, (_, i) => codemode.echo({ i })));
return results;
```

Acceptance:

- all calls resolve correctly
- rejected host calls reject the correct QuickJS promise
- timeout/cancellation rejects pending calls
- runtime/context memory is released after execution

### Deno — optional/future executor

A Deno subprocess executor exists in the repo from the earlier implementation path. It should become optional/future support behind the same executor interface.

Deno advantages:

- process-level isolation
- explicit permissions
- strong security story when installed

Deno disadvantages:

- external runtime dependency
- duplex subprocess protocol complexity
- not required for MVP

### Node VM — skipped for now

`../pi-codemode-old` used Node `vm`, `esbuild`, and `zx`. That was useful prior art, but Node `vm` is not a strong security boundary. It should not be part of the MVP executor matrix.

## Lessons from `../pi-codemode-old`

Useful modules/designs to adapt:

- `type-checker.ts`
  - virtual TypeScript compiler host
  - fast host-side checks
- `search.ts`
  - MiniSearch index for tool discovery
- `tool-bindings.ts`
  - Pi tool wrapper pattern
  - MCP namespace proxy pattern
- `mcp-client.ts`
  - lazy MCP connection
  - metadata cache integration
- `execute-tool.ts`
  - `execute_tools` public tool shape
  - result/error formatting
- `index.ts`
  - Pi lifecycle, flag, and command registration

Things intentionally changed:

- `tools.*` API -> `codemode.*`
- `zx` host shell -> `just-bash`
- Node `vm` executor -> QuickJS target, Deno optional
- old JSON Schema -> TypeScript generator -> Cloudflare helper where suitable

## just-bash integration

Shell workflows are exposed through:

```ts
await $`rg TODO src`;
await shell({ command: "find src -name '*.ts'" });
```

This is not host bash. It is `just-bash` over scoped filesystem mounts.

Default filesystem strategy:

```txt
/workspace  -> project root, read/write
/tmp        -> in-memory temp space
/home/user  -> optional in-memory home
/refs       -> optional read-only reference material
```

Important defaults:

- project mounted read/write at `/workspace`
- generated code has no direct filesystem access
- shell sees only configured mounts
- network disabled by default
- `just-bash` JS/Python disabled by default

`just-bash` also ships `js-exec` backed by QuickJS/WASM. That is useful reference material, but the codemode executor should own QuickJS directly so it can inject the exact API surface and async host bridge needed by `execute_tools`.

## MCP integration

MCP tools are codemode-only unless configured elsewhere.

Design:

- load MCP metadata cache at startup
- expose tools in generated code through nested namespaces:

```ts
await codemode.github.search_issues({ query: "is:open label:bug" });
```

- connect MCP servers lazily on first actual call
- do not register MCP tools as top-level Pi tools
- use `search_tools` and `describe_tools` for progressive discovery

Missing/stale metadata is a UX tradeoff:

- warm cache is fastest
- connect-at-boot is more complete but slower
- one-correction retry may be needed when metadata refreshes mid-session

## Type checking and type generation

The public `execute_tools.code` parameter is a TypeScript code body, not an async arrow function.

Host-side flow:

1. generate TypeScript declarations from JSON Schema/MCP metadata
2. type-check user code before execution
3. only execute after type check succeeds

Type errors should clearly state that code was not executed.

## Security model

The generated code is untrusted. The host dispatcher is the authority.

Defense in depth:

```txt
QuickJS executor: no direct host fs/env/net/run/process access
just-bash: shell commands scoped to configured mounts and command policy
host dispatcher: only approved codemode functions are callable
```

Denied by default:

- arbitrary host bash
- host network from generated code
- direct filesystem access from generated code
- direct env access from generated code
- subprocess spawning from generated code
- `just-bash` network
- `just-bash` JS/Python runtimes

## Current GitHub tracking

The active source of truth for remaining work is GitHub issue tracking:

- Epic: <https://github.com/boozedog/pi-codemode/issues/1>
- QuickJS executor: <https://github.com/boozedog/pi-codemode/issues/2>
- Executor cleanup: <https://github.com/boozedog/pi-codemode/issues/3>
- just-bash polish: <https://github.com/boozedog/pi-codemode/issues/4>
- MCP polish: <https://github.com/boozedog/pi-codemode/issues/5>
- Tests/evaluation: <https://github.com/boozedog/pi-codemode/issues/6>
- Docs: <https://github.com/boozedog/pi-codemode/issues/7>
