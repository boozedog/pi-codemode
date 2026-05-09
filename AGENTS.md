# pi-codemode Agent Instructions

## Development approach: TDD first

All new behavior must be developed test-first.

1. Write or update a focused failing test that describes the desired behavior.
2. Run the relevant test command and confirm it fails for the expected reason.
3. Implement the smallest change that can make the test pass.
4. Run the test again and confirm it passes.
5. Refactor only after tests are green.
6. Repeat in small slices.

Do not add broad implementation before there is a failing test covering the behavior.

## Test expectations

- Prefer small unit tests for executor, type generation, command quoting, config merging, and bridge behavior.
- Add integration tests for cross-component workflows only after the involved units are covered.
- For bug fixes, first add a regression test that fails on the current code.
- Tests should assert observable behavior, not implementation details, unless the detail is a security/resource-safety requirement.

## Current MVP priority

The main MVP path is the QuickJS executor:

- QuickJS is the default executor target.
- Deno is optional/future and should stay behind the executor interface.
- Do not add a Node VM executor for MVP.
- Generated code should only access explicit globals: `codemode`, `$`, `shell`, `print`, and `π`.
- Host tool calls must support async success, async failure, concurrency, timeout/cancellation, and clean runtime/context disposal.

## Required QuickJS executor test slices

Before expanding executor features, keep these behaviors covered by tests:

- returns primitive and object values
- captures `print` / console output
- injects `π` string constants
- awaits one async host tool call
- resolves many concurrent host tool calls via `Promise.all`
- propagates rejected host calls to the guest promise
- supports nested MCP-style namespaces, e.g. `codemode.github.search_issues(...)`
- times out runaway code
- does not expose Node or host globals such as `process`, `require`, filesystem, environment, network, or subprocess APIs
- releases QuickJS runtime/context memory cleanly after execution

## Code style

- TypeScript source lives in `src/`; generated build output lives in `dist/`.
- Do not edit `dist/` directly. Run the build instead.
- Keep executor-specific code under `src/executor/`.
- Keep public execution flow in `src/execute-tool.ts` independent of a concrete executor where practical.
- Use TypeBox/JSON Schema for public Pi-facing schema definitions.

## Commands

- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Format: `npm run format`
- Format check: `npm run format:check`
- Full local check: `npm run check`
- When changing TypeScript, run `npm run build` before reporting completion.
- When adding behavior, run the smallest relevant test first, then the full test suite when feasible.
- Keep oxlint, oxfmt, and Vitest checks in the TDD loop.

## Security model reminders

- Generated code must not get direct host filesystem, environment, network, subprocess, or Node APIs.
- Shell workflows go through `just-bash` via `$` / `shell()`, not unrestricted host bash.
- MCP tools are exposed inside codemode only unless separately configured elsewhere.
- Prefer explicit allow/deny policies and test them.

## Working notes

- Keep changes small and reviewable.
- If a spike is necessary, label it as a spike and backfill tests before turning it into production code.
- If tests reveal a design issue, pause and discuss before layering more code on top.
