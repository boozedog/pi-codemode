# Pi Codemode Implementation Plan

## 1. Vision

Build a new Pi plugin that brings the Cloudflare Codemode pattern to Pi, while remaining native to Pi's tool system, schema system, and local-agent workflow.

The core idea:

> The model receives one primary tool, `execute_tools`, and writes TypeScript code that orchestrates many internal capabilities: Pi tools, codemode-only MCP tools, and safe shell-like commands backed by `just-bash`.

This is a new plugin design. We are **not** providing a migration path or compatibility layer for `@georgebashi/pi-codemode`. The old repo is prior art and a source of useful implementation pieces, not an API contract.

This should preserve the major benefits of Cloudflare Codemode:

- fewer model/tool round trips
- explicit control flow with TypeScript
- parallelism via `Promise.all`
- typed tool APIs
- progressive disclosure of large tool surfaces
- better ergonomics for MCP servers with many tools

But adapt the runtime to Pi:

- Pi's agent/tool lifecycle remains the outer orchestration layer
- Pi's `TypeBox` schemas remain the plugin-facing schema system
- Cloudflare's Vercel AI SDK adapter is avoided unless strictly useful
- execution is pluggable, with Deno as the preferred local sandbox candidate
- shell access is safe-by-default through `just-bash`, not arbitrary host bash
- codemode-only MCP tools are configured separately and are not registered as normal Pi tools

## 2. Design Principles

### 2.1 Pi-native at the boundary

The plugin should expose normal Pi concepts outwardly:

- one Pi tool: `execute_tools`
- optional Pi command: `/codemode`
- optional Pi flag: `--no-codemode`
- TypeBox schemas for the public Pi tool definition
- Pi TUI rendering hooks for calls/results

Cloudflare Codemode internals may be used, but Pi should not need to become an AI SDK application.

### 2.2 Cloudflare Codemode as reusable core, not necessarily as AI SDK adapter

Cloudflare's package appears to expose separable concepts:

- `generateTypes(tools)`
- `sanitizeToolName(name)`
- an `Executor` interface
- `createCodeTool(...)` under `@cloudflare/codemode/ai` for AI SDK integration

The Pi plugin should prefer lower-level exports over `@cloudflare/codemode/ai`.

Goal:

```txt
Pi ToolDefinition
  -> Pi codemode adapter
  -> Cloudflare codemode core helpers where useful
  -> pluggable executor
  -> Pi/codemode tool dispatcher
```

Avoid:

```txt
Pi
  -> Vercel AI SDK streamText
  -> AI SDK tool()
  -> Cloudflare Codemode
```

### 2.3 Safe local execution by default

The old prototype ran code through Node `vm`. That is easy but not a strong security boundary.

The new plugin should make execution pluggable and prefer a stronger local sandbox. Deno is the leading candidate because it supports native TypeScript and permission-based sandboxing.

### 2.4 No arbitrary host bash by default

The plugin should not expose a direct host bash tool in codemode by default.

Instead, expose a `$` tagged-template shell API backed by `just-bash` and scoped filesystem mounts.

Example preferred API:

```ts
const matches = await $`grep -rn TODO src`;
await $`sed -i 's/old/new/g' README.md`;
```

Optional richer structured wrappers can come later, but the primary UX should preserve familiar shell syntax.

These commands run through `just-bash` over configured mounts such as `/workspace`, not unrestricted host shell.

### 2.5 MCP tools are codemode-only unless explicitly registered elsewhere

Codemode-specific MCP servers should be configured in codemode config files and exposed only inside the `execute_tools` TypeScript API.

They should not pollute Pi's top-level tool list.

## 3. Reference Implementations / Prior Art

### 3.1 `../pi-codemode-old`

The old repo already implements a Pi-native version of the pattern:

- `src/index.ts` toggles Pi into a single-tool mode
- `src/execute-tool.ts` defines `execute_tools`
- `src/sandbox.ts` type-checks, transpiles, and runs code in Node `vm`
- `src/type-checker.ts` builds a virtual TypeScript compiler host
- `src/type-generator.ts` generates TypeScript definitions for tools/MCP/packages
- `src/mcp-client.ts` lazily connects MCP servers via `pi-mcp-adapter`
- `src/search.ts` builds MiniSearch over tools
- `src/package-resolver.ts` auto-installs user-configured npm packages

Useful ideas to keep:

- single `execute_tools` Pi tool
- before-execution type checking
- compact prompt plus progressive tool discovery
- `search_tools` / `describe_tools`
- MCP lazy connection
- output truncation semantics
- `strings` parameter exposed as `π.key`
- custom TUI rendering

Issues to avoid/improve:

- Node `vm` as the only executor
- direct zx/host-shell exposure as a default
- stale type/search state after uncached MCP live discovery
- no tests despite `npm test`
- package injection complexity before core design is proven
- assuming YAML exists in prompt when it may not

### 3.2 Cloudflare Codemode

Cloudflare docs: <https://github.com/cloudflare/agents/blob/main/docs/codemode.md>

Confirmed characteristics:

- package: `@cloudflare/codemode`
- AI SDK integration: `@cloudflare/codemode/ai`
- examples use Vercel AI SDK's `tool()` and `streamText()`
- examples use Zod schemas
- Cloudflare runtime executor: `DynamicWorkerExecutor`
- executor interface is intentionally minimal
- can theoretically support Node VM, QuickJS, containers, or other sandboxes
- supports raw tool descriptors in addition to AI SDK tool sets, according to docs

Important doc excerpt conceptually:

```ts
interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}
```

This is the seam we should target.

### 3.3 `just-bash`

Package: `just-bash`
Repo: `vercel-labs/just-bash`

Characteristics:

- simulated bash environment
- virtual filesystem
- many Unix-like commands
- optional JS/TS via QuickJS with `javascript: true`
- optional Python support
- no network by default
- can define custom commands
- not a hard VM sandbox itself

Supported command families include:

- file operations: `cat`, `cp`, `ls`, `mkdir`, `mv`, `rm`, `stat`, `touch`, `tree`
- text processing: `grep`, `rg`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, etc.
- data: `jq`, `yq`, `sqlite3`, `xan`
- archive/compression: `tar`, `gzip`
- shell basics: `find`, `echo`, `printf`, `xargs`, `timeout`, etc.

Security model note from package: execution happens without VM isolation. It is safer than host bash because the shell sees only the provided filesystem and has no network by default, but it is not equivalent to Deno/Worker/container isolation.

## 4. Proposed Architecture

```txt
┌─────────────────────────────────────────────────────────────────┐
│ Pi Agent                                                        │
│                                                                 │
│  Active tool list: [execute_tools]                              │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Pi Codemode Plugin                                        │  │
│  │                                                           │  │
│  │  - registers execute_tools                                │  │
│  │  - builds codemode tool descriptors                       │  │
│  │  - generates prompt/types                                 │  │
│  │  - owns dispatcher for Pi/MCP/just-bash tools              │  │
│  │                                                           │  │
│  │  ┌──────────────────────┐    ┌────────────────────────┐  │  │
│  │  │ Tool Registry         │    │ Executor               │  │  │
│  │  │                      │    │                        │  │  │
│  │  │ Pi safe tools         │    │ deno / node-vm /       │  │  │
│  │  │ just-bash commands    │    │ quickjs / cloudflare   │  │  │
│  │  │ codemode-only MCP     │    │                        │  │  │
│  │  └──────────┬───────────┘    └───────────┬────────────┘  │  │
│  │             │                            │               │  │
│  │             └──────── JSON-RPC / bridge ─┘               │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Inside generated code:

```ts
const [pkg, readme] = await Promise.all([
  codemode.read({ path: "package.json" }),
  codemode.read({ path: "README.md" }),
]);

const todos = await $`rg TODO src`; // backed by just-bash, scoped to configured mounts

const issues = await codemode.github_search_issues({ query: "is:open label:bug" });

return { deps: Object.keys(JSON.parse(pkg).dependencies ?? {}), todos, issues };
```

Potential naming alternatives:

- `codemode.read(...)` matches Cloudflare docs
- `tools.read(...)` matches old Pi prototype

Decision: use `codemode.*` to align with Cloudflare Codemode terminology.

## 5. Major Components

### 5.1 Pi extension entry point

Responsibilities:

- register `--no-codemode`
- register `/codemode` toggle
- register `execute_tools`
- on session start:
  - remember original active tools
  - build internal codemode tool registry
  - activate only `execute_tools`
- on prompt injection:
  - append concise codemode instructions
  - include type surface or a compact summary, depending on size
- on shutdown:
  - stop MCP clients
  - stop active executors/subprocesses
  - clean temp dirs

### 5.2 Tool registry

Internal registry of functions available to generated code.

Each internal tool descriptor should include:

```ts
interface CodemodeToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema / TypeBox-compatible
  execute(args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
  source: "pi" | "just-bash" | "mcp" | "system";
  namespace?: string;
  originalName?: string;
}
```

The registry should support:

- name sanitization
- collision handling
- search index generation
- type definition generation
- dispatch by sanitized name
- describing original source/schema

### 5.3 Public `execute_tools` Pi tool

Suggested TypeBox schema:

```ts
Type.Object({
  code: Type.String({
    description: "TypeScript/JavaScript code body to execute. Use top-level await and return."
  }),
  strings: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "Named string constants exposed as π.key inside code."
  }))
})
```

Use a TypeScript **code body**, not an async arrow function.

Old Pi prototype used a body:

```ts
const x = await tools.read(...);
return x;
```

Decision:

- the public `execute_tools.code` parameter is a body
- the implementation wraps it internally in an async function/IIFE as needed
- do not accept both body and function expression in the public contract

Rationale:

- less boilerplate for the model
- old repo already proved this UX
- simpler prompt and tests
- no need to normalize multiple user-facing formats

### 5.4 Type generation

Options:

1. Use Cloudflare `generateTypes(tools)` directly.
2. Use Cloudflare only for sanitization/executor semantics and write Pi-specific JSON Schema → TypeScript generation.
3. Hybrid: try Cloudflare generation; patch/augment for Pi-specific helpers like `π`, `print`, `search_tools`, `describe_tools`.

Questions to answer by source inspection:

- Does `generateTypes()` accept JSON Schema descriptors without Zod?
- Does it generate good TS from TypeBox schemas?
- Does it support nested namespaces, or only flat function names?
- Can we include JSDoc descriptions on properties?
- How are optional/required properties represented?
- How are enums/unions handled?

Likely initial implementation:

- adapt Pi/TypeBox schemas to raw Cloudflare descriptors
- call Cloudflare `generateTypes`
- if insufficient, port/improve the old repo's JSON Schema → TS converter

### 5.5 Progressive disclosure tools

Large MCP surfaces should not be fully dumped into prompt context.

Internal codemode should include system discovery tools:

```ts
codemode.search_tools({ query: string }): Promise<string>
codemode.describe_tools({ namespace: string; tool?: string }): Promise<string>
codemode.list_tools({ source?: string; namespace?: string }): Promise<string>
```

Prefer the old repo's `describe_tools({ namespace, tool? })` shape over a separate `describe_tool({ name })` function. One call can both list a namespace and describe a specific tool, which gives the model one fewer concept to track.

Examples:

```ts
print(await codemode.describe_tools({ namespace: "github" }));
print(await codemode.describe_tools({ namespace: "github", tool: "search_issues" }));
```

The system prompt should say:

- use `search_tools` to discover capabilities
- use `describe_tools` before calling unfamiliar MCP tools
- type errors happen before execution when supported

### 5.6 Executor abstraction

Define our own plugin executor interface, even if it closely matches Cloudflare's.

```ts
interface CodeExecutor {
  name: string;
  execute(input: CodeExecutionInput): Promise<CodeExecutionResult>;
  shutdown?(): Promise<void>;
}

interface CodeExecutionInput {
  code: string;
  typeDefs: string;
  tools: Record<string, CodemodeHostFunction>;
  strings?: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (update: ExecutionUpdate) => void;
}

interface CodeExecutionResult {
  success: boolean;
  result?: unknown;
  logs: string[];
  error?: {
    kind: "type" | "runtime" | "timeout" | "cancelled" | "internal";
    message: string;
    line?: number;
    column?: number;
    stack?: string;
  };
  elapsedMs: number;
}
```

Even if Cloudflare's `Executor` is used, wrap it behind this interface.

## 6. Executor Options

### 6.1 Deno executor — preferred target

Deno is a strong candidate for the default local sandbox.

Potential command:

```sh
deno run \
  --quiet \
  --no-prompt \
  --cached-only? \
  --allow-read=<maybe none> \
  <bootstrap.ts>
```

Ideally, do not grant project filesystem access directly. Communicate over stdin/stdout JSON-RPC.

Generated code should only access host capabilities through an injected `codemode` proxy.

Important separation: Deno does **not** read the project and does **not** host the just-bash filesystem. The Pi plugin host process owns Pi tool execution and `just-bash`'s `ReadWriteFs(project)` / `MountableFs`. When generated code calls `codemode.read(...)` or `$\`rg TODO src\``, Deno sends a framed RPC request; the host process performs the file/shell operation and sends back a serialized result. Deno only sees protocol frames.

#### 6.1.1 Deno permissions

Deno defaults to no access unless permissions are granted.

Relevant permissions:

- `--allow-read`
- `--allow-write`
- `--allow-net`
- `--allow-env`
- `--allow-run`
- `--allow-ffi`
- `--allow-sys`

Recommended default:

- no `--allow-net`
- no `--allow-env`
- no `--allow-run`
- no project `--allow-read`
- no project `--allow-write`
- perhaps allow read of a generated bootstrap file only, or avoid by passing code via stdin

Always use:

```sh
--no-prompt
```

to prevent permission prompts from hanging the subprocess.

#### 6.1.2 Deno IPC protocol

Deno IPC is a Phase 0 spike item, not a detail to defer until implementation. Duplex subprocess protocols are where sandboxes often become flaky.

The MVP should use a framed protocol rather than ad-hoc `console.log(JSON.stringify(...))`.

Preferred options, in order:

1. **LSP-style Content-Length framing** over stdin/stdout.
2. Newline-delimited JSON only if the bootstrap has robust buffering, EOF handling, and tests.
3. A dedicated IPC library only if it works cleanly with Deno subprocesses and does not weaken sandboxing.

LSP framing example:

```txt
Content-Length: 73\r\n
\r\n
{"type":"tool_call","id":1,"name":"read","args":{"path":"package.json"}}
```

The host and Deno bootstrap both need a real frame reader that handles:

- partial chunks
- multiple frames in one chunk
- invalid JSON
- EOF before a complete frame
- child process exit while calls are pending
- back-pressure when many `Promise.all` calls are in flight
- cancellation/timeout that rejects all pending calls

Deno generated runtime sends protocol messages to host.

Request:

```json
{"type":"tool_call","id":1,"name":"read","args":{"path":"package.json"}}
```

Response:

```json
{"type":"tool_result","id":1,"result":"..."}
```

Error response:

```json
{"type":"tool_error","id":1,"error":{"message":"file not found"}}
```

Log message:

```json
{"type":"log","level":"log","args":["found",3,"files"]}
```

Final result:

```json
{"type":"done","result":{"ok":true}}
```

Runtime error:

```json
{"type":"runtime_error","error":{"message":"...","stack":"..."}}
```

Protocol rules:

- stdout is protocol frames only
- generated-code `console.*` and `print()` become protocol `log` frames
- stderr is reserved for Deno/bootstrap internal failures
- the host must reject all pending calls if the child exits or the protocol stream closes
- the host should enforce a maximum number of in-flight calls to avoid unbounded memory growth

#### 6.1.3 Deno bootstrap design

Bootstrap responsibilities:

- create `globalThis.codemode` proxy
- create `globalThis.print`
- create `globalThis.π`
- capture console methods
- evaluate generated code
- send final result/error

Pseudo-code:

```ts
const pending = new Map<number, { resolve, reject }>();
let nextId = 1;

function callTool(name: string, args: unknown) {
  const id = nextId++;
  send({ type: "tool_call", id, name, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

globalThis.codemode = new Proxy({}, {
  get(_, prop) {
    return (args?: unknown) => callTool(String(prop), args ?? {});
  }
});

globalThis.print = (...args) => send({ type: "log", level: "print", args });
globalThis.π = Object.freeze(strings);

const fn = normalizeToAsyncFunction(userCode);
const result = await fn();
send({ type: "done", result });
```

The bootstrap must start a response-reader task before evaluating user code. That reader continuously parses frames from `Deno.stdin.readable` and resolves/rejects entries in `pending`.

This must be prototyped during Phase 0 with tests for concurrent calls:

```ts
await Promise.all(Array.from({ length: 100 }, (_, i) => codemode.echo({ i })));
```

Do not proceed to the full executor until the framing/duplex prototype is reliable.

#### 6.1.4 Type checking with Deno

Options:

1. Use TypeScript compiler in host before launching Deno.
2. Ask Deno to type-check.
3. Rely on Cloudflare's type generation but skip full checking initially.

Recommendation:

- host-side type check for best error formatting and no side effects
- reuse or adapt old `type-checker.ts`
- later investigate whether Cloudflare package provides normalization/type checking helpers

Deno runs already-transformed or raw TS only after host type check passes.

### 6.2 Node VM executor — dev fallback

Useful for rapid implementation and tests.

Pros:

- easy to implement
- no external runtime dependency
- old repo has working code

Cons:

- not a strong sandbox
- should not be default long-term

### 6.3 QuickJS executor

Potential packages:

- `quickjs-emscripten`
- custom QuickJS wrapper
- possibly via `just-bash` `js-exec`, though that may be less direct

Pros:

- stronger isolation than Node `vm`
- pure local sandbox
- no direct Node built-ins

Cons:

- async host function bridge complexity
- TypeScript must be transformed before execution
- compatibility/perf constraints

Good candidate after Deno or as an alternative when Deno is unavailable.

### 6.4 Cloudflare Worker executor

May be useful only when Pi is running in a Cloudflare-compatible environment.

Probably not a local Pi default.

### 6.5 Container / Vercel Sandbox executor

Possible future option for strong isolation plus real shell/binaries.

Not a default due to complexity.

## 7. just-bash Integration

### 7.1 Goal

Expose safe shell-like capabilities backed by `just-bash`, not host bash.

The important distinction is not "string shell bad, argv wrapper good". The important distinction is:

```txt
host shell over host filesystem       = not default
just-bash shell over scoped mounts    = default
```

`just-bash` accepts command strings and provides bash syntax. We should preserve that ergonomics. A coding model already knows shell syntax extremely well, and forcing every operation through `shell_rg({ args: [...] })` would be a needless UX regression.

Recommended default API inside codemode:

```ts
const result = await $`grep -rn TODO src`;
const files = await $`find src -name '*.ts'`;
const changed = await $`sed -i 's/old/new/g' README.md`;
```

This `$` is **not** zx and does **not** execute host bash. It is a tagged-template wrapper around `just-bash` running inside the configured filesystem mounts.

Also expose an explicit function form for generated/dynamic commands:

```ts
await shell({ command: "rg TODO src" });
```

Do not expose arbitrary host `bash`, `sh`, `zx`, or `child_process` by default.

### 7.2 Initial shell surface

Phase 1: expose:

```ts
/** just-bash tagged template. Runs in scoped MountableFs, not host bash. */
declare function $(parts: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>;

/** Function form for cases where the command is assembled dynamically. */
declare function shell(params: { command: string; cwd?: string }): Promise<ShellResult>;
```

Return type:

```ts
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

Tagged-template interpolation must quote/escape interpolated values. Literal shell syntax remains literal, just like zx ergonomics, but execution is through `just-bash`.

Example:

```ts
const pattern = "TODO";
const dir = "src";
const result = await $`rg ${pattern} ${dir}`;
```

The wrapper should turn interpolated values into safe shell tokens before sending the command string to `just-bash`.

### 7.3 Optional rich/discrete wrappers later

Discrete command wrappers are optional convenience helpers, not the primary UX.

Possible future helpers:

```ts
grep({ pattern, path?, recursive?, lineNumbers?, include?, exclude? })
find({ path, name?, type?, maxDepth? })
jq({ filter, file? , input? })
rg({ pattern, path?, glob?, ignoreCase? })
```

These may be useful for models that prefer structured arguments, but they should not replace `$` for normal shell-like workflows.

### 7.4 Filesystem strategy

Key decision: how does `just-bash` see project files?

Options:

#### A. Read/write project mount — MVP default

Mount the real project directory at `/workspace` using `just-bash` filesystem support such as `ReadWriteFs` / `MountableFs`.

Pros:

- everyday coding-agent behavior matches user expectations
- `rg`, `find`, `sed -i`, `mv`, `rm`, etc. operate on the actual workspace
- no stale snapshot problem
- no separate write-back/export path
- just-bash still provides filesystem scoping and command allow/deny controls

Cons:

- commands can mutate project files
- requires careful mount boundaries
- needs clear prompt guidance about preferred edit flows

#### B. MountableFs with multiple mounts — recommended architecture

Use `MountableFs` to compose a scoped filesystem view:

```txt
/workspace     -> project root, read/write
/refs          -> optional reference material, read-only
/tmp           -> in-memory temp space, read/write
/home/user     -> in-memory home, read/write
```

This is where `just-bash` can outshine direct `zx`: the shell gets a Unix-like filesystem with explicit mounts and permissions rather than the entire host filesystem.

Example use cases:

- mount the current project read/write at `/workspace`
- mount `~/.pi/refs` read-only at `/refs`
- mount generated scratch space at `/tmp`
- optionally mount dependency docs or reference repos read-only

#### C. Snapshot mode — opt-in/niche

Copy selected files into an in-memory filesystem.

Good for:

- diffing against a reference state
- deterministic experiments
- letting the model transform files without touching disk
- tests

Not recommended as the everyday default because coding agents normally need commands to see and mutate the live workspace.

#### D. Overlay mode — opt-in

Use an overlay where reads fall through to the project but writes land in an upper layer.

Good for:

- previewing changes before applying them
- speculative edits
- future approval workflows

More complex than the MVP.

Recommendation for MVP:

- default to `ReadWriteFs(project)` mounted at `/workspace`
- run just-bash with cwd `/workspace`
- use `MountableFs` from the start, even with only one project mount
- support read-only auxiliary mounts soon after
- keep `snapshot` and `overlay` as explicit opt-in modes

### 7.5 Write policy

Default: `just-bash` writes mutate the mounted project filesystem.

This means both of these are real write paths:

```ts
await codemode.write({ path: "file.ts", content: newContent });
await $`sed -i 's/old/new/g' file.ts`;
```

We should still recommend Pi `write`/`edit` for precise multi-line source edits, because those operations produce clearer audit trails and better error messages. But `sed -i`, `mv`, `rm`, generated files, formatting commands, and other normal shell mutations should not be fake/no-op by default.

The prompt should say:

- use `codemode.write` / `codemode.edit` for deliberate source edits
- use `$` for search, inspection, transforms, generated files, and standard Unix workflows
- remember `$` is just-bash over `/workspace`, not host bash

### 7.6 Mount configuration

Support explicit mounts in config.

Example:

```jsonc
{
  "justBash": {
    "filesystem": {
      "mode": "readwrite",
      "cwd": "/workspace",
      "mounts": [
        { "path": "/workspace", "source": ".", "access": "rw" },
        { "path": "/refs", "source": "~/.pi/refs", "access": "ro", "optional": true },
        { "path": "/tmp", "type": "memory", "access": "rw" }
      ]
    }
  }
}
```

Mount rules:

- project mount defaults to read/write
- auxiliary mounts default to read-only unless explicitly set
- paths outside configured mounts are invisible
- symlink handling must not allow escaping mount boundaries

### 7.7 Network and optional runtimes

Default:

- `just-bash` network disabled
- `javascript` disabled
- `python` disabled

Enable only via config.

Given Deno already runs generated TS, `just-bash` `js-exec` is likely unnecessary initially.

## 8. MCP Integration

### 8.1 Codemode-only MCP config

Support global and project codemode config files:

```txt
~/.pi/agent/codemode.json
$PROJECT/.pi/codemode.json
```

Example:

```jsonc
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
        }
      },
      "linear": {
        "command": "npx",
        "args": ["-y", "linear-mcp"]
      }
    }
  }
}
```

Project config should override global entries of the same name.

### 8.2 MCP exposure

MCP tools should be registered only in the internal codemode registry.

They should not call `pi.registerTool()` individually.

Preferred generated API:

```ts
codemode.github.search_issues(...)
codemode.linear.create_issue(...)
```

Nested namespaces are the default design to evaluate, not an afterthought. The old repo's `tools.<server>.<tool>` shape is better for discoverability and usually cheaper/clearer in type definitions than one giant flat symbol list.

Flat names remain a fallback if Cloudflare core or the executor bridge cannot represent nested namespaces cleanly:

```ts
codemode.github_search_issues(...)
codemode.linear_create_issue(...)
```

Name sanitization is still needed inside each namespace because MCP tool names may contain hyphens, dots, spaces, or reserved words.

### 8.3 MCP metadata strategy

Be honest about the type-checking constraint: refreshing MCP metadata mid-execution cannot help code that is already running or code that failed type-check before execution.

Viable strategies:

#### A. Warm-cache at boot — preferred default

- read cached MCP metadata during plugin startup
- generate types/search index from cache
- connect lazily for actual calls
- if cache is missing/stale, tools from that server are unavailable until metadata is refreshed outside the current execution

#### B. Connect-at-boot — opt-in

- connect to configured MCP servers during session start
- get live tool metadata before generating types
- slower startup but best first-call experience

#### C. One-correction flow — acceptable fallback

- if metadata is missing, `describe_tools`/`list_tools` can connect and refresh host-side registry
- the current code execution may still fail or lack types
- the model must call `execute_tools` again after the refreshed metadata is available

Do not describe mid-execution type refresh as a solved feature. Treat it as a UX tradeoff among warm-cache, connect-at-boot, and one-correction retry.

### 8.4 Tool discovery

Add codemode functions:

```ts
search_tools({ query: string }): Promise<string>
describe_tools({ namespace: string; tool?: string }): Promise<string>
list_mcp_servers(): Promise<string>
list_tools({ namespace?: string }): Promise<string>
```

The prompt should teach:

```ts
const found = await codemode.search_tools({ query: "github issue" });
print(found);
print(await codemode.describe_tools({ namespace: "github" }));
print(await codemode.describe_tools({ namespace: "github", tool: "search_issues" }));
```

### 8.5 MCP schema conversion

MCP input schemas are JSON Schema-like. They should flow naturally into TypeScript type generation.

Need robust handling for:

- required properties
- optional properties
- arrays
- enums
- unions (`anyOf`, `oneOf`)
- nullable fields
- nested objects
- additionalProperties
- weird schemas from real MCP servers

## 9. Configuration

Proposed config file:

```jsonc
{
  "executor": {
    "type": "deno",
    "timeoutMs": 120000
  },
  "shell": {
    "timeoutMs": 120000
  },
  "justBash": {
    "enabled": true,
    "commands": {
      "allow": ["rg", "grep", "find", "jq", "sed", "ls", "cat", "wc", "sort", "uniq", "head", "tail"],
      "deny": []
    },
    "filesystem": {
      "mode": "readwrite",
      "cwd": "/workspace",
      "mounts": [
        { "path": "/workspace", "source": ".", "access": "rw" },
        { "path": "/refs", "source": "~/.pi/refs", "access": "ro", "optional": true },
        { "path": "/tmp", "type": "memory", "access": "rw" }
      ],
      "respectGitignore": true,
      "snapshot": {
        "maxFiles": 10000,
        "maxBytes": 52428800
      }
    },
    "network": false,
    "javascript": false,
    "python": false
  },
  "mcp": {
    "servers": {}
  },
  "packages": {
    // Future: optional injected packages, if still wanted
  }
}
```

Layering:

1. built-in defaults
2. global config `~/.pi/agent/codemode.json`
3. project config `$PROJECT/.pi/codemode.json`
4. CLI flags, if added

## 10. TypeBox, Zod, and Cloudflare Tool Descriptors

Pi uses TypeBox for tool schemas.

Cloudflare examples use Zod through AI SDK:

```ts
import { tool } from "ai";
import { z } from "zod";
```

But Cloudflare docs indicate `createCodeTool` accepts:

```ts
tools: ToolSet | ToolDescriptors
```

and browser examples show raw JSON Schema-style descriptors.

Therefore preferred path:

```txt
Pi TypeBox schema
  -> JSON Schema-compatible descriptor
  -> Cloudflare codemode core
```

Avoid TypeBox -> Zod conversion unless source inspection proves raw descriptors are insufficient.

Potential losses from skipping Zod:

- Zod refinements/transforms/custom validation messages
- Zod-specific type generation behavior
- AI SDK automatic validation path

But Pi tools do not use Zod-specific features, so this is acceptable.

## 11. Prompt Design

The system prompt addition should be much shorter than old repo if possible.

Must include:

- what codemode is
- code should use `codemode.*`
- use `Promise.all` for independent operations
- use `search_tools` / `describe_tools` for discovery
- use `print()` for logs
- return final result
- use `π.key` for awkward strings
- shell commands use `$` / `shell()` backed by just-bash, not host bash
- just-bash runs over scoped mounts, with `/workspace` read/write by default
- real file writes can happen through either `codemode.write`/`codemode.edit` or just-bash commands like `sed -i`

Example prompt fragment:

````markdown
## Code Mode

You can call `execute_tools` with TypeScript code. The code runs in a sandbox and can call available functions on `codemode`.

Use parallelism for independent work:

```ts
const [pkg, readme] = await Promise.all([
  codemode.read({ path: "package.json" }),
  codemode.read({ path: "README.md" })
]);
return { pkg, readme };
```

Use `codemode.search_tools({ query })` and `codemode.describe_tools({ namespace, tool? })` to discover MCP and shell capabilities.

Do not assume host bash exists. Use `$` for shell-like workflows; it is backed by just-bash over the scoped `/workspace` mount, not by host bash.

```ts
const todos = await $`rg TODO src`;
await $`sed -i 's/old/new/g' README.md`;
```

Prefer `codemode.write` / `codemode.edit` for precise source edits, but standard shell mutations are real writes to `/workspace`.
```
````

## 12. Output Handling

Need consistent output truncation for:

- generated code return values
- `print()` logs
- just-bash stdout/stderr
- MCP results
- runtime errors

Borrow old repo limits:

- max 2000 lines
- max 50KB default
- tail truncation
- preserve full output in temp file when possible
- sanitize control characters that break TUI rendering

But do **not** blindly borrow the old in-process `TruncatedString` proxy design. In the old Node VM executor, the proxy worked because shell output and user code lived in the same process. With Deno + RPC, shell output crosses a serialization boundary.

Decision for MVP:

- truncation for display happens on the host after tool results return
- values sent back into Deno are plain strings/objects, not host-side proxies
- if a command output is huge, the host may return a structured shell result with truncated display fields and an explicit full-output handle/path

Possible shell result shape:

```ts
interface ShellResult {
  stdout: string;          // truncated for transport/display if needed
  stderr: string;          // truncated for transport/display if needed
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string; // host temp file, readable via an explicit tool if needed
}
```

Open design question: if we want old behavior where `stdout.slice(-500)` operates on full output, that proxy must be implemented inside the Deno bootstrap or replaced with explicit APIs such as `read_output_tail({ handle, bytes })`. Do not assume the old proxy transfers across JSON-RPC.

Deno protocol logs should be captured as structured logs, not raw stdout.

## 13. Error Handling

Classify errors:

- type errors: code did not execute
- runtime errors: code executed and threw
- tool errors: a codemode function failed
- timeout errors
- cancellation errors
- executor/bootstrap/internal errors
- protocol errors

Return model-friendly messages:

```txt
Type errors (code was NOT executed):
Line 3: Property 'foo' does not exist...

Fix the type errors and try again.
```

For tool/MCP errors, include schema hints when possible.

## 14. Security Model

### 14.1 Trust boundary

The generated code is untrusted.

The host tool dispatcher is the true authority.

Even with Deno sandboxing, dangerous host capabilities can be exposed through codemode functions. Therefore safe defaults matter.

`just-bash` by itself is meaningful scoping, but not an airtight sandbox; its own security model says execution is not VM-isolated. The stronger design is defense-in-depth:

```txt
Deno executor: generated TypeScript cannot directly reach host fs/env/net/run
just-bash: shell tool calls see only configured mounts/commands
host dispatcher: only approved codemode functions are callable
```

If we skip Deno and run generated code in Node `vm`, `just-bash` still improves the shell layer but the overall trust boundary is weaker.

### 14.2 Default capabilities

Default allowed:

- project-scoped read/write/edit through Pi tools
- shell commands through `just-bash` scoped to configured mounts, with `/workspace` read/write by default
- configured codemode MCP tools
- discovery tools

Default denied:

- arbitrary host bash
- host network from generated code
- direct filesystem access from generated code
- direct env access from generated code
- Deno subprocess spawning
- `just-bash` network
- `just-bash` JS/Python runtimes

### 14.3 Host file mutations

Real project mutations may happen through two sanctioned paths:

1. Pi-backed `codemode.write` / `codemode.edit`
2. just-bash commands operating inside the read/write `/workspace` mount

This is intentional. `sed -i`, `mv`, `rm`, generated files, and formatter-like workflows should behave like normal coding-agent shell operations, while still being scoped by `MountableFs` rather than unrestricted host bash.

Prompt guidance should recommend `codemode.write` / `codemode.edit` for precise source edits and `$` for shell-native workflows.

### 14.4 Performance considerations

`just-bash` command execution goes through a TypeScript parser/dispatcher rather than native process exec. It will likely be slower than `zx`/host shell for command-heavy workflows, especially repeated greps over large repositories.

This needs measurement, not guessing. Benchmarks should compare:

- native `rg` via host shell
- `just-bash` `rg`
- `just-bash` `grep/find` combinations
- repeated small commands vs fewer batched commands
- large repository traversal through `ReadWriteFs` / `MountableFs`

If performance is poor, possible mitigations:

- encourage batching in prompt examples
- add specialized high-performance host-side search tools with strict path scoping
- cache filesystem traversal/indexes
- keep host shell as an explicit unsafe/advanced opt-in, not default

### 14.5 MCP risk

MCP servers can be powerful. Since they are configured explicitly for codemode, users are responsible for what they expose. Future work could include approval gates or deny policies per MCP tool.

## 15. Implementation Phases

### Phase 0: Source inspection and protocol spike

Goals:

- install/read `@cloudflare/codemode`
- inspect exports
- determine if raw ToolDescriptors work without AI SDK/Zod
- determine code normalization behavior
- determine whether `generateTypes` is reusable
- specifically determine whether Cloudflare type generation can represent nested namespaces; if not, plan to keep/adapt old repo's nested MCP type generation and use Cloudflare only for narrower pieces such as sanitization/executor conventions
- inspect descriptor shapes
- prototype Deno duplex IPC with LSP-style framing
- stress-test concurrent `Promise.all` tool calls, EOF handling, child death, and timeout cleanup
- decide whether to port old repo code as the base or rewrite around selected pieces

Sequencing: Cloudflare source inspection and Deno IPC prototyping are independent and can run in parallel. The port-vs-rewrite decision follows Cloudflare inspection, because what we port depends on what Cloudflare core actually gives us.

Deliverable:

- short findings doc or comments in this file
- go/no-go on using Cloudflare core directly
- go/no-go on Deno framed IPC design
- explicit port-vs-rewrite decision before Phase 1

### Phase 1: Minimal Pi plugin skeleton

Implement:

- package setup
- Pi extension entry point
- `execute_tools` tool with TypeBox schema
- `/codemode` toggle
- `--no-codemode`
- basic prompt injection
- internal tool registry

Executor can initially be Node VM for speed, but behind the final executor interface.

Before implementing Phase 1, decide port-vs-rewrite. Current bias: port/adapt the old repo's well-engineered pieces (`execute-tool`, type checker, JSON Schema type generation, truncation utilities, search) rather than starting from blank files.

### Phase 2: Type generation and type checking

Implement:

- JSON Schema -> TS type generation or Cloudflare `generateTypes`
- host-side TypeScript checker
- useful line-number mapping
- `print()` and `π` declarations
- simple built-in tools: read/write/edit/search/describe

Acceptance:

- bad parameter types fail before execution
- valid code calls tools successfully
- type error strings and line mappings have golden tests
- golden tests cover common self-correction cases, because these messages are part of the model-facing contract

### Phase 3: Deno executor

Implement:

- Deno runtime detection
- Deno bootstrap
- LSP-style framed RPC bridge
- timeout/cancellation
- log capture
- result/error formatting

Acceptance:

- generated code has no direct fs/env/net/run access
- generated code can call host tools via RPC
- long-running code is killed on timeout

### Phase 4: just-bash integration

Implement:

- create `Bash` instance
- `ReadWriteFs(project)` mounted at `/workspace`
- `MountableFs` support for `/workspace`, `/tmp`, and optional read-only refs
- `$` tagged-template wrapper backed by just-bash
- `shell({ command, cwd? })` function form
- allow/deny command policy
- return structured `{ stdout, stderr, exitCode }`
- search/describe integration
- output truncation
- initial performance benchmark against native `rg`/`find`

Acceptance:

- model can run `$\`rg TODO src\`` and `$\`find . -name '*.ts'\``
- `$` commands execute in `/workspace`, not host bash
- `sed -i` and other writes mutate the mounted project files
- paths outside configured mounts are invisible/inaccessible
- optional `/refs` mount is read-only

### Phase 5: Codemode-only MCP

Implement:

- config parsing
- MCP server manager
- lazy connect
- metadata cache if practical
- schema/type generation for MCP tools
- nested namespace exposure by default, with flat sanitized names only as fallback
- search/describe/list functions

Acceptance:

- MCP tools are callable inside codemode
- MCP tools are not visible as normal Pi tools
- large MCP surfaces do not bloat the top-level prompt

### Phase 6: Polish

Implement:

- TUI rendering
- better prompt examples
- config docs
- test suite
- output truncation temp files
- cancellation cleanup
- better schema edge cases
- package distribution metadata

## 16. Testing Strategy

### 16.1 Unit tests

- schema to TS conversion
- name sanitization and collision handling
- config merging
- command quoting
- output truncation
- JSON-RPC protocol parsing
- Deno bootstrap normalization

### 16.2 Integration tests

- execute simple code
- type error prevents execution
- runtime error returns logs before error
- read/write/edit through Pi tool wrappers
- just-bash `$` command over `/workspace` mount
- timeout kills Deno
- cancellation kills Deno
- MCP fake server call

### 16.3 Security-oriented tests

Deno generated code should fail for:

```ts
await Deno.readTextFile("package.json")
Deno.env.get("HOME")
await fetch("https://example.com")
new Deno.Command("sh", { args: ["-c", "echo hi"] }).output()
```

Unless explicitly enabled.

just-bash should not access files outside configured mounts. Read-only mounts should reject writes, including via symlink escape attempts.

### 16.4 Evaluation harness

Add a small evaluation harness once Phase 2 can execute typed code. This is separate from unit/integration tests: it measures whether the new architecture is improving against our own intended goals and catches regressions across phases.

Suggested fixed tasks:

- read several files and summarize package metadata
- search a repo for TODOs and aggregate by directory
- perform a precise multi-file edit
- run a Promise.all-heavy workflow over multiple independent reads/searches
- discover and call a fake MCP server tool
- use `$` for grep/find/sed workflows over `/workspace`

Metrics:

- success rate on fixed LLM-driven prompts
- number of outer model/tool round trips
- prompt/token footprint of the tool surface
- wall-clock latency
- Deno executor overhead vs Node VM fallback
- just-bash search latency vs native `rg` baseline
- quality of type-error self-correction messages

Do not evaluate against `../pi-codemode-old`; that repo is only a code reference point, not a product baseline.

## 17. Decisions and Open Questions

### 17.1 Decisions made

- Public generated API should be `codemode.*`, not `tools.*`, to align with Cloudflare Codemode terminology.
- `execute_tools.code` should be a TypeScript code body, not an async arrow function.
- MCP exposure should prefer nested namespaces: `codemode.github.search_issues(...)`.
- just-bash should be exposed primarily through `$` / `shell()`, not argv-only `shell_rg` wrappers.
- just-bash should default to read/write `/workspace` via `ReadWriteFs` / `MountableFs`.
- This project is a new plugin, not a compatibility release of `@georgebashi/pi-codemode`.

### 17.2 Open questions

1. Which Cloudflare codemode exports are actually usable outside AI SDK?
2. Does Cloudflare `generateTypes` support raw JSON Schema descriptors well enough?
3. Can Cloudflare core represent nested namespaces cleanly, or do we need Pi-specific type generation for that?
4. How should missing/stale MCP metadata be handled by default: warm-cache only, connect-at-boot opt-in, or another strategy?
5. How well does `ReadWriteFs` / `MountableFs` perform on large repositories?
6. Which auxiliary mounts should be provided by default, if any (`~/.pi/refs`, dependency docs, temp dirs)?
7. Should host bash ever be available behind explicit opt-in?
8. Should Deno be required, auto-installed, or optional with Node VM fallback?
9. Exact port-vs-rewrite boundary: which old repo modules are copied/adapted versus replaced?

## 18. Initial Recommendation

Build the MVP in this order:

1. In parallel: inspect `@cloudflare/codemode` source and prototype Deno framed IPC.
2. Confirm raw descriptor and nested namespace support, or decide to keep old repo type generation for nested MCP.
3. Decide port-vs-rewrite boundaries for old repo modules.
4. Create Pi plugin skeleton with `execute_tools`.
5. Implement registry + type generation + Node VM executor as temporary dev path.
6. Add the Phase 2 evaluation harness as soon as typed execution works.
7. Add Deno executor and make it the default when available.
8. Add just-bash `$` / `shell()` over a read/write `/workspace` mount with a small command allowlist.
9. Add codemode-only MCP config and lazy tool dispatch.

The conceptual target stack:

```txt
Pi plugin
  -> Cloudflare codemode core helpers where useful
  -> Pi-native execute_tools wrapper
  -> Deno sandbox executor
  -> JSON-RPC host dispatcher
  -> Pi safe tools + just-bash commands + codemode-only MCP
```

This preserves Cloudflare Codemode's best idea while making it local, Pi-native, safer by default, and extensible.
