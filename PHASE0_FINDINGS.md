# Phase 0: Source Inspection and Protocol Spike Findings

## Date: 2026-05-09

## 1. Cloudflare Codemode Inspection

### Exports from `@cloudflare/codemode`

**Core utilities (usable without AI SDK/Zod):**

1. `generateTypesFromJsonSchema(tools: JsonSchemaToolDescriptors): string`
   - ✅ **Confirmed working** - generates TypeScript from JSON Schema
   - ✅ No AI SDK dependency
   - ✅ No Zod dependency
   - Accepts: `{ [name]: { description?, inputSchema: JSONSchema7, outputSchema? } }`

2. `jsonSchemaToType(schema: JSONSchema7, typeName: string): string`
   - Converts single JSON Schema to TypeScript type
   - ✅ Can be used for individual parameter types

3. `sanitizeToolName(name: string): string`
   - Replaces hyphens, dots, spaces with `_`
   - Prefixes digit-leading names with `_`
   - Appends `_` to JS reserved words
   - ✅ **Confirmed working and reusable**

4. `normalizeCode(code: string): string`
   - Normalizes code body vs function expression
   - ✅ **Confirmed working**

5. `Executor` interface
   - `execute(code, providersOrFns): Promise<ExecuteResult>`
   - ✅ **Can be implemented for Deno sandbox**

6. `DynamicWorkerExecutor`
   - ❌ Cloudflare Workers only - not usable for local Pi
   - Uses `cloudflare:workers` RPC

### Key Finding: Nested Namespaces

The `Executor.execute()` accepts `ResolvedProvider[]` where each provider has a `name`:
```ts
{ name: "github", fns: { search_issues: fn } }
{ name: "slack", fns: { channels_me: fn } }
```

This maps to `github.search_issues()` and `slack.channels_me()` in sandbox code.
✅ **Nested namespaces ARE supported by Cloudflare's design.**

### Type Generation Comparison

| Feature | Old Repo | Cloudflare |
|---------|----------|------------|
| JSON Schema input | ✅ | ✅ |
| Nested namespaces | ✅ (custom) | ✅ (providers) |
| JSDoc descriptions | ✅ | ? (needs testing) |
| Enums | ✅ | ? |
| Unions (anyOf/oneOf) | ✅ | ? |
| Optional params | ✅ | ? |

**Decision:** Use Cloudflare's `generateTypesFromJsonSchema` for the main implementation, keep old repo's as fallback if needed.

## 2. Old Repo (`../pi-codemode-old`) Port vs Rewrite Analysis

### Modules to Port/Adapt (high value, proven designs)

| Module | Port? | Notes |
|--------|-------|-------|
| `type-checker.ts` | ✅ **Port** | Virtual TS compiler host, ~5ms/check, well-tested |
| `tool-bindings.ts` | ✅ **Port** | Pi tool wrappers, MCP proxy pattern |
| `search.ts` | ✅ **Port** | MiniSearch integration, proven design |
| `mcp-client.ts` | ✅ **Port** | Lazy connect, cache integration via `pi-mcp-adapter` |
| `system-prompt.ts` | ✅ **Port** | Prompt design, examples, progressive disclosure |
| `execute-tool.ts` | ✅ **Port** | Tool definition, renderCall/renderResult |
| `index.ts` | ✅ **Port** | Extension lifecycle, flag/command registration |

### Modules to Replace

| Module | Replace With | Reason |
|--------|--------------|--------|
| `type-generator.ts` | Cloudflare `generateTypesFromJsonSchema` | Standard, maintained |
| `sandbox.ts` (Node VM) | **Deno executor** (new) | Stronger sandbox, native TS |
| `zx` shell | **just-bash** | Safe-by-default, scoped mounts |

### Dependencies to Remove/Replace

| Old | New | Reason |
|-----|-----|--------|
| `zx` | `just-bash` | Safe shell over scoped mounts |
| `esbuild` | Deno native | Deno runs TS directly |
| Custom JSON Schema→TS | Cloudflare | Standard, tested |

## 3. Deno IPC Protocol Spike

### Recommended Protocol: LSP-style Content-Length Framing

Based on the implementation plan and Cloudflare's RPC pattern:

**Host (Pi plugin) ←→ Deno subprocess**

Request frame (Host → Deno):
```
Content-Length: 73\r\n
\r\n
{"type":"tool_call","id":1,"name":"read","args":{"path":"file.ts"}}
```

Response frame (Deno → Host):
```
Content-Length: 56\r\n
\r\n
{"type":"tool_result","id":1,"result":"file content here"}
```

Log frame (Deno → Host):
```
Content-Length: 48\r\n
\r\n
{"type":"log","level":"print","args":["found",3,"files"]}
```

Done frame (Deno → Host):
```
Content-Length: 36\r\n
\r\n
{"type":"done","result":{"ok":true}}
```

Error frame (Deno → Host):
```
Content-Length: 65\r\n
\r\n
{"type":"runtime_error","error":{"message":"...","stack":"..."}}
```

### Bootstrap Design (Deno side)

```ts
// deno-bootstrap.ts
const pending = new Map<number, { resolve, reject }>();
let nextId = 1;

function callTool(name: string, args: unknown) {
  const id = nextId++;
  send({ type: "tool_call", id, name, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// Create proxies
globalThis.codemode = new Proxy({}, {
  get(_, prop) {
    return (args?: unknown) => callTool(String(prop), args ?? {});
  }
});

globalThis.print = (...args) => send({ type: "log", level: "print", args });
globalThis.π = Object.freeze(strings);

// Start response reader
startResponseReader();

// Execute user code
const result = await userCodeFn();
send({ type: "done", result });
```

### Deno Permissions (strict by default)

```bash
deno run \
  --quiet \
  --no-prompt \
  --allow-read=/tmp/bootstrap \
  --allow-write=/tmp/bootstrap \
  deno-bootstrap.ts
```

No `--allow-net`, `--allow-env`, `--allow-run`, project `--allow-read/write`.

### Open Questions for Phase 1-3

1. **just-bash integration:** Does `just-bash` expose `MountableFs` / `ReadWriteFs`?
   - Need to inspect `just-bash` package

2. **Type generation edge cases:**
   - How does Cloudflare handle deeply nested objects?
   - Does it preserve JSDoc descriptions?
   - Needs testing with real MCP schemas

3. **Deno bootstrap bundling:**
   - Inline the bootstrap in the plugin, or read from file?
   - Inline avoids file system dependencies

## 4. Port vs Rewrite Decision

### Clear Port (adapt to new architecture):
- `type-checker.ts` - virtual TS compiler host
- `search.ts` - MiniSearch tool index
- `tool-bindings.ts` - Pi tool wrappers
- `mcp-client.ts` - MCP lazy connect (may simplify)
- `system-prompt.ts` - prompt content
- `execute-tool.ts` - tool definition structure
- `index.ts` - extension lifecycle

### New Implementation:
- **Deno executor** - RPC bridge, bootstrap, protocol
- **just-bash integration** - `$` tagged template, mount configuration
- **Config system** - codemode.json schema

### Replace with Cloudflare:
- Type generation → `generateTypesFromJsonSchema`
- Name sanitization → `sanitizeToolName`
- Code normalization → `normalizeCode`

## 5. Next Steps (Phase 1 Start)

1. Create project structure ✅ (done)
2. Install dependencies (`@cloudflare/codemode`, `minisearch`, etc.)
3. Port `type-checker.ts` (foundation for Phase 2)
4. Port `search.ts`
5. Create basic `index.ts` with flag/command registration
6. Create stub `execute_tools` tool

**Risk area to prototype early:** Deno IPC protocol with concurrent `Promise.all` calls. This should be a standalone spike test before full integration.
