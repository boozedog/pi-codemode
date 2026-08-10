export interface NpmScriptCall {
  tool: string;
  operation: string;
  args: Record<string, unknown>;
}

export interface NpmScriptPlan {
  script: string;
  calls: NpmScriptCall[];
}

const DENIED_COMMANDS = new Set(["node", "npm", "npx", "bash", "sh", "python", "python3"]);
const SHELL_CONSTRUCTS = ["|", ">", "<", "$", "`", "(", ")", ";", "||"];

export function planNpmScript(scripts: Record<string, string>, script: string): NpmScriptPlan {
  return { script, calls: resolveScript(scripts, script, []) };
}

function resolveScript(
  scripts: Record<string, string>,
  script: string,
  chain: string[],
): NpmScriptCall[] {
  if (chain.includes(script)) {
    throw new Error(
      `cycle detected while resolving npm scripts: ${[...chain, script].join(" -> ")}`,
    );
  }
  const command = scripts[script];
  if (command === undefined) throw new Error(`npm script '${script}' is not defined`);
  const nextChain = [...chain, script];
  return splitSafeAnd(command, script, nextChain).flatMap((part) =>
    decomposeCommand(scripts, script, nextChain, tokenize(part)),
  );
}

function splitSafeAnd(command: string, script: string, chain: string[]): string[] {
  rejectShellConstructs(command, script, chain);
  return command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean);
}

function rejectShellConstructs(command: string, script: string, chain: string[]): void {
  for (const construct of SHELL_CONSTRUCTS) {
    if (command.includes(construct)) {
      fail(script, chain, `unsupported shell construct '${construct}'`);
    }
  }
}

function decomposeCommand(
  scripts: Record<string, string>,
  script: string,
  chain: string[],
  argv: string[],
): NpmScriptCall[] {
  const command = argv[0];
  if (!command) return [];
  if (command === "npm" && argv[1] === "run" && typeof argv[2] === "string" && argv.length === 3) {
    return resolveScript(scripts, argv[2], chain);
  }
  if (command === "npm" && argv[1] === "test" && argv.length === 2) {
    return resolveScript(scripts, "test", chain);
  }
  if (DENIED_COMMANDS.has(command)) {
    fail(script, chain, `command '${command}' is denied. Use surfaced cli.* tools instead.`);
  }
  if (command === "tsc") return [decomposeTsc(script, chain, argv)];
  if (command === "oxfmt") return [decomposeOxfmt(script, chain, argv)];
  if (command === "oxlint") return [decomposeOxlint(script, chain, argv)];
  if (command === "vp") return [decomposeVp(script, chain, argv)];
  if (command === "vitest" && argv[1] === "run" && argv.length === 2) {
    return [{ tool: "vitest", operation: "run", args: {} }];
  }
  fail(script, chain, `unsupported command '${command}'`);
}

function decomposeVp(script: string, chain: string[], argv: string[]): NpmScriptCall {
  if (argv[1] !== "fmt") fail(script, chain, `unsupported vp subcommand '${argv[1] ?? ""}'`);
  return decomposeVpFmt(script, chain, argv.slice(2));
}

function decomposeVpFmt(script: string, chain: string[], args: string[]): NpmScriptCall {
  const paths: string[] = [];
  let mode: "check" | "write" | undefined;
  let ignorePath: string | undefined;
  let threads: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check" || arg === "--write") {
      if (mode) fail(script, chain, "vp fmt requires exactly one of --check or --write");
      mode = arg === "--check" ? "check" : "write";
    } else if (arg === "--ignore-path") {
      ignorePath = args[++i];
      if (!ignorePath) fail(script, chain, "vp fmt --ignore-path requires a path");
    } else if (arg === "--threads") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        fail(script, chain, "vp fmt --threads requires a positive integer");
      }
      threads = value;
    } else if (arg.startsWith("-")) {
      fail(script, chain, `unsupported vp fmt argument: ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (!mode) fail(script, chain, "vp fmt requires exactly one of --check or --write");
  const optionalArgs = {
    ...(paths.length > 0 ? { paths } : {}),
    ...(ignorePath ? { ignorePath } : {}),
    ...(threads ? { threads } : {}),
  };
  return { tool: "vp", operation: mode === "check" ? "fmtCheck" : "fmtWrite", args: optionalArgs };
}

function decomposeOxfmt(script: string, chain: string[], argv: string[]): NpmScriptCall {
  if (argv.length === 3 && argv[2] === "--check") {
    return { tool: "oxfmt", operation: "check", args: { paths: [argv[1]] } };
  }
  if (argv.length === 3 && argv[2] === "--write") {
    return { tool: "oxfmt", operation: "write", args: { paths: [argv[1]] } };
  }
  fail(script, chain, `unsupported oxfmt arguments: ${argv.slice(1).join(" ")}`);
}

function decomposeOxlint(script: string, chain: string[], argv: string[]): NpmScriptCall {
  if (
    argv.length === 5 &&
    argv[1] === "--deny" &&
    argv[2] === "warnings" &&
    argv[3] === "--vitest-plugin"
  ) {
    return {
      tool: "oxlint",
      operation: "run",
      args: { deny: "warnings", vitestPlugin: true, paths: [argv[4]] },
    };
  }
  fail(script, chain, `unsupported oxlint arguments: ${argv.slice(1).join(" ")}`);
}

function decomposeTsc(script: string, chain: string[], argv: string[]): NpmScriptCall {
  if (argv.length === 1) return { tool: "tsc", operation: "build", args: {} };
  if (argv.length === 2 && argv[1] === "--watch") {
    return { tool: "tsc", operation: "build", args: { watch: true } };
  }
  fail(script, chain, `unsupported tsc arguments: ${argv.slice(1).join(" ")}`);
}

function tokenize(command: string): string[] {
  return command.split(/\s+/u).filter(Boolean);
}

function fail(script: string, chain: string[], reason: string): never {
  throw new Error(
    `Refusing to decompose npm script '${script}' (chain: ${chain.join(" -> ")}): ${reason}`,
  );
}

/** Pretty-print a planned cli.* call args object for agent-readable plans. */
export function formatCliCallArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "{}";

  const parts = keys.map((key) => {
    const value = args[key];
    return `${formatObjectKey(key)}: ${formatCliArgValue(value)}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function formatObjectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatCliArgValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((item) => formatCliArgValue(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    return formatCliCallArgs(value as Record<string, unknown>);
  }
  return JSON.stringify(value);
}

export function formatNpmScriptPlan(script: string, calls: NpmScriptCall[]): string {
  const lines = [`Plan for npm run ${script}:`];
  for (const call of calls) {
    lines.push(`- cli.${call.tool}.${call.operation}(${formatCliCallArgs(call.args)})`);
  }
  lines.push("", "No commands were executed.");
  return lines.join("\n");
}
