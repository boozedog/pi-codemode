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
  if (command === "vitest" && argv[1] === "run" && argv.length === 2) {
    return [{ tool: "vitest", operation: "run", args: {} }];
  }
  fail(script, chain, `unsupported command '${command}'`);
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
