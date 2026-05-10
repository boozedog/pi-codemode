// shell.ts — Safe shell execution via just-bash.
//
// Provides $ tagged template and shell() function backed by just-bash,
// not direct host bash. Uses MountableFs for scoped filesystem access.

import { Bash, MountableFs, ReadWriteFs, InMemoryFs } from "just-bash";

export interface ShellOptions {
  /** Project root directory (mounted at /workspace) */
  projectRoot: string;
  /** Read-only reference mounts */
  readOnlyMounts?: Array<{ path: string; source: string }>;
  /** In-memory temp directory (mounted at /tmp) */
  enableTemp?: boolean;
  /** Home directory simulation (mounted at /home/user) */
  enableHome?: boolean;
  /** Command allowlist (if empty, all just-bash commands allowed) */
  allowedCommands?: string[];
  /** Command denylist */
  deniedCommands?: string[];
  /** Max command execution time in ms */
  timeoutMs?: number;
  /** Max stdout/stderr bytes returned inline before storing full output in /tmp */
  maxOutputBytes?: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutFile?: string;
  stderrFile?: string;
}

interface ShellContext {
  bash: Bash;
  fs: MountableFs;
  options: ShellOptions;
  outputCounter: number;
}

// Global shell context per project
const shellContexts = new Map<string, ShellContext>();

/**
 * Initialize the shell for a project.
 */
export async function initShell(options: ShellOptions): Promise<void> {
  const key = options.projectRoot;

  // Cleanup existing context if any
  if (shellContexts.has(key)) {
    shellContexts.delete(key);
  }

  // Create mountable filesystem
  const fs = new MountableFs();

  // Mount project root at /workspace
  const projectFs = new ReadWriteFs({ root: options.projectRoot });
  fs.mount("/workspace", projectFs);

  // Mount read-only references
  if (options.readOnlyMounts) {
    for (const mount of options.readOnlyMounts) {
      const refFs = new ReadWriteFs({ root: mount.source });
      fs.mount(mount.path, refFs);
    }
  }

  // Mount temp directory
  if (options.enableTemp !== false) {
    const tmpFs = new InMemoryFs({});
    fs.mount("/tmp", tmpFs);
  }

  // Mount home directory
  if (options.enableHome) {
    const homeFs = new InMemoryFs({});
    fs.mount("/home/user", homeFs);
  }

  // Create Bash instance with custom fs
  const bash = new Bash({
    fs,
    cwd: "/workspace",
    env: {
      HOME: "/home/user",
      PWD: "/workspace",
      TERM: "dumb",
      CI: "true",
    },
    network: undefined,
    python: false,
    javascript: false,
  });

  shellContexts.set(key, { bash, fs, options, outputCounter: 0 });
}

/**
 * Get shell context for a project.
 * Returns null if shell has not been initialized.
 */
function getShellContext(projectRoot: string): ShellContext | null {
  return shellContexts.get(projectRoot) ?? null;
}

/**
 * Execute a shell command via just-bash.
 */
export async function executeJustBash(
  projectRoot: string,
  command: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ShellResult> {
  const ctx = getShellContext(projectRoot);
  if (!ctx) {
    throw new Error("Shell not initialized");
  }

  // Check command allowlist/denylist
  const cmd = getPolicyCommand(command);
  if (ctx.options.deniedCommands?.includes(cmd)) {
    return {
      stdout: "",
      stderr: `Command "${cmd}" is not allowed`,
      exitCode: 1,
    };
  }
  if (
    ctx.options.allowedCommands &&
    ctx.options.allowedCommands.length > 0 &&
    !ctx.options.allowedCommands.includes(cmd)
  ) {
    return {
      stdout: "",
      stderr: `Command "${cmd}" is not in the allowed list. Use codemode.search_tools() to find alternatives.`,
      exitCode: 1,
    };
  }

  const timeoutMs = options.timeoutMs ?? ctx.options.timeoutMs ?? 60000;

  try {
    // just-bash currently does not expose a per-command timeout option in all versions.
    // Race manually so runaway commands don't hang the host.
    const result = await Promise.race([
      ctx.bash.exec(command),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Shell command timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    const maxOutput = options.maxOutputBytes ?? ctx.options.maxOutputBytes ?? 50 * 1024;
    const truncated = await truncateOutputs(
      ctx,
      result.stdout ?? "",
      result.stderr ?? "",
      maxOutput,
    );

    return {
      ...truncated,
      exitCode: result.exitCode ?? 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: message,
      exitCode: 1,
    };
  }
}

/**
 * Tagged template function for shell commands.
 *
 * Usage: await $\`ls -la\`
 *
 * Interpolated values are automatically escaped/quoted for safety.
 */
async function truncateOutputs(
  ctx: ShellContext,
  stdout: string,
  stderr: string,
  maxOutput: number,
): Promise<Omit<ShellResult, "exitCode">> {
  let truncatedStdout = stdout;
  let truncatedStderr = stderr;
  let stdoutFile: string | undefined;
  let stderrFile: string | undefined;

  if (stdout.length > maxOutput) {
    stdoutFile = await writeFullOutput(ctx, stdout);
    truncatedStdout =
      stdout.slice(-maxOutput) +
      `\n[Output truncated, showing last ${formatBytes(maxOutput)}. Full stdout: ${stdoutFile}]`;
  }
  if (stderr.length > maxOutput) {
    stderrFile = await writeFullOutput(ctx, stderr);
    truncatedStderr =
      stderr.slice(-maxOutput) +
      `\n[Output truncated, showing last ${formatBytes(maxOutput)}. Full stderr: ${stderrFile}]`;
  }

  return { stdout: truncatedStdout, stderr: truncatedStderr, stdoutFile, stderrFile };
}

async function writeFullOutput(ctx: ShellContext, content: string): Promise<string> {
  ctx.outputCounter += 1;
  const path = `/tmp/codemode-shell-output-${Date.now()}-${ctx.outputCounter}.txt`;
  await ctx.fs.writeFile(path, content, "utf-8");
  return path;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes} bytes`;
}

function getPolicyCommand(command: string): string {
  const normalized = command.trim();
  const afterCwd = normalized.match(/^cd\s+\S+\s+&&\s+(.+)$/)?.[1] ?? normalized;
  const tokens = afterCwd.trim().split(/\s+/).filter(Boolean);
  const commandToken = tokens.find((token) => !/^[_A-Za-z][_A-Za-z0-9]*=.*/.test(token));
  return commandToken ?? "";
}

export function createShellTag(projectRoot: string) {
  return function (strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult> {
    // Build command string with safe interpolation
    let command = "";
    for (let i = 0; i < strings.length; i++) {
      command += strings[i];
      if (i < values.length) {
        // Quote interpolated values for safety
        const val = values[i];
        if (typeof val === "string") {
          // Simple shell quoting - wrap in single quotes, escape existing single quotes
          command += "'" + val.replace(/'/g, "'\\''") + "'";
        } else {
          command += String(val);
        }
      }
    }

    return executeJustBash(projectRoot, command.trim());
  };
}

/**
 * Function form for shell execution.
 *
 * Usage: await shell({ command: "ls -la", cwd: "/workspace" })
 */
export function createShellFunction(projectRoot: string) {
  return async function (options: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<ShellResult> {
    let command = options.command;

    // Handle cwd by prepending cd command
    if (options.cwd && options.cwd !== "/workspace") {
      const rawCwd = options.cwd.startsWith("/") ? options.cwd : `/workspace/${options.cwd}`;
      // Normalize path by resolving . and .. segments (prevent path traversal)
      const normalizedPath = rawCwd.replace(/\\/g, "/").replace(/\/+/g, "/");
      const parts = normalizedPath.split("/").filter((p) => p.length > 0);
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === "..") {
          resolved.pop();
        } else if (part !== ".") {
          resolved.push(part);
        }
      }
      const normalizedCwd = "/" + resolved.join("/");

      // Validate cwd is within allowed mounts
      if (
        !normalizedCwd.startsWith("/workspace/") &&
        !normalizedCwd.startsWith("/tmp/") &&
        !normalizedCwd.startsWith("/home/") &&
        normalizedCwd !== "/workspace" &&
        normalizedCwd !== "/tmp" &&
        normalizedCwd !== "/home"
      ) {
        return {
          stdout: "",
          stderr: `Invalid cwd: ${options.cwd}. Must be within /workspace, /tmp, or /home`,
          exitCode: 1,
        };
      }
      command = `cd ${normalizedCwd} && ${command}`;
    }

    return executeJustBash(projectRoot, command, {
      timeoutMs: options.timeoutMs,
    });
  };
}

/**
 * Generate TypeScript type definitions for shell API.
 */
export function generateShellTypeDefs(): string {
  return `\
// --- Shell commands via just-bash (safe, scoped to /workspace) ---

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** just-bash tagged template. Runs in scoped MountableFs, not host bash. */
declare function $(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<ShellResult>;

/** Function form for cases where the command is assembled dynamically. */
declare function shell(options: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<ShellResult>;
`;
}

/**
 * Cleanup shell resources.
 */
export async function disposeShell(projectRoot: string): Promise<void> {
  if (shellContexts.has(projectRoot)) {
    shellContexts.delete(projectRoot);
  }
}

/**
 * Dispose all shell contexts.
 */
export async function disposeAllShells(): Promise<void> {
  shellContexts.clear();
}
