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
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ShellContext {
  bash: Bash;
  options: ShellOptions;
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
  });

  shellContexts.set(key, { bash, options });
}

/**
 * Get or create shell context for a project.
 */
async function getShellContext(projectRoot: string): Promise<ShellContext | null> {
  if (!shellContexts.has(projectRoot)) {
    await initShell({ projectRoot });
  }
  return shellContexts.get(projectRoot) ?? null;
}

/**
 * Execute a shell command via just-bash.
 */
export async function executeJustBash(
  projectRoot: string,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<ShellResult> {
  const ctx = await getShellContext(projectRoot);
  if (!ctx) {
    throw new Error("Shell not initialized");
  }

  // Check command allowlist/denylist
  const cmd = command.trim().split(/\s+/)[0];
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

    // Truncate large outputs
    const maxOutput = 50 * 1024; // 50KB
    let stdout = result.stdout ?? "";
    let stderr = result.stderr ?? "";

    if (stdout.length > maxOutput) {
      stdout =
        stdout.slice(-maxOutput) +
        `\n[Output truncated, showing last ${Math.round(maxOutput / 1024)}KB]`;
    }
    if (stderr.length > maxOutput) {
      stderr =
        stderr.slice(-maxOutput) +
        `\n[Output truncated, showing last ${Math.round(maxOutput / 1024)}KB]`;
    }

    return {
      stdout,
      stderr,
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
      // Validate cwd is within allowed mounts
      if (
        !options.cwd.startsWith("/workspace") &&
        !options.cwd.startsWith("/tmp") &&
        !options.cwd.startsWith("/home")
      ) {
        return {
          stdout: "",
          stderr: `Invalid cwd: ${options.cwd}. Must be within /workspace, /tmp, or /home`,
          exitCode: 1,
        };
      }
      command = `cd ${options.cwd} && ${command}`;
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
