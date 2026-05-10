# Shell Integration Notes

Issue #4 hardening status for `$` and `shell()`.

## Filesystem scoping

Codemode shell uses `just-bash` `MountableFs` with the project mounted at `/workspace` through `ReadWriteFs`, plus in-memory `/tmp` and optional `/home/user`.

Regression coverage confirms:

- commands fail before shell initialization
- `shell({ cwd })` accepts only `/workspace`, `/tmp`, and `/home` mount roots
- relative cwd values are resolved under `/workspace`
- cwd traversal such as `/workspace/../../../etc` and `../../../etc` is rejected
- workspace symlink escapes do not leak host file contents through the mounted filesystem

## Command policy

Codemode applies a host-side command allow/deny policy before dispatching to just-bash:

- `deniedCommands` blocks named commands
- `allowedCommands` permits only named commands when non-empty
- policy evaluation skips the `cd ... &&` prefix inserted for validated cwd handling

## Output truncation

Large stdout/stderr values are truncated inline. Full output is written to `/tmp/codemode-shell-output-*.txt` inside the just-bash filesystem and returned as `stdoutFile`/`stderrFile` handles on the shell result.

## Tagged-template quoting

`$` quotes string interpolations with single-quote shell escaping. Regression coverage verifies an interpolation containing quotes and command separators is passed as data rather than executed as extra commands.

## Runtime surface

The shell bridge explicitly keeps optional just-bash JavaScript and Python commands disabled by default:

```ts
python: false,
javascript: false,
network: undefined,
```

Network commands remain unavailable unless a future configuration deliberately provides a just-bash network policy.

## Quick benchmark note

Local spot check on this repository after `npm run build`:

| command                 | native host | just-bash | result |
| ----------------------- | ----------: | --------: | ------ |
| `find src -name "*.ts"` |        17ms |       9ms | exit 0 |
| `rg --files src`        |        20ms |      18ms | exit 0 |

These are small-repo smoke numbers, not a rigorous benchmark suite. Codemode keeps just-bash for safety and portability rather than assuming host shell access. For MVP, the practical guidance is:

- use `$`/`shell()` for scoped shell workflows inside codemode
- use file tools and MCP tools directly when possible
- do not expose unrestricted host shell just to optimize command speed
