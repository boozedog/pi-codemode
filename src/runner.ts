import { existsSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface JobPackage {
  root: string;
  entry: string;
  name?: string;
  description?: string;
  handoff?: boolean;
  prompt?: string;
}

export interface RunInvocation {
  job: string;
  args: Record<string, string>;
}

/** Parse the single value accepted by both `--run` and `/run`. */
export function parseRunInvocation(input: string): RunInvocation {
  const tokens = tokenizeRunInput(input);
  const job = tokens.shift();
  if (!job) throw new Error("Usage: /run <skill-name-or-path> [key=value|--key[=value]]");

  const args: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    if (equals > 0 && !token.startsWith("--")) {
      args[token.slice(0, equals)] = token.slice(equals + 1);
      continue;
    }
    if (!token.startsWith("--") || token.length === 2) {
      throw new Error(`Invalid run argument: ${token}`);
    }
    const body = token.slice(2);
    const bodyEquals = body.indexOf("=");
    if (bodyEquals >= 0) {
      if (bodyEquals === 0) throw new Error(`Invalid run argument: ${token}`);
      args[body.slice(0, bodyEquals)] = body.slice(bodyEquals + 1);
      continue;
    }
    const key = body;
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return { job, args };
}

function tokenizeRunInput(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      token += char;
      escaping = false;
    } else if (char === "\\" && quote) {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += char;
    }
  }
  if (escaping || quote) throw new Error("Unterminated quote in run invocation");
  if (token) tokens.push(token);
  return tokens;
}

function parseSkillMetadata(path: string): {
  name?: string;
  description?: string;
  entry?: string;
  handoff?: boolean;
} {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const values: Record<string, string> = {};
  let section = "";
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^(name|description|codemode-entry|handoff):\s*(.*)$/.exec(line.trim());
    if (match) {
      const value = match[2].replace(/^['"]|['"]$/g, "");
      values[match[1]] = value;
      if (match[1] === "codemode-entry") values.entry = value;
    }
    if (line.trim() === "metadata:") section = "metadata";
    else if (section && /^\s+codemode-entry:\s*(.*)$/.test(line)) {
      values.entry = (/^\s+codemode-entry:\s*(.*)$/.exec(line)?.[1] ?? "").replace(
        /^['"]|['"]$/g,
        "",
      );
    }
  }
  return {
    name: values.name,
    description: values.description,
    entry: values.entry,
    handoff: values.handoff === "true",
  };
}

/** Resolve a skill and its optional model handoff prompt. */
export function resolveJobPackage(
  input: string,
  cwd = process.cwd(),
  roots?: string[],
): JobPackage {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  const packageRoot =
    existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : undefined;
  const searchRoots = roots ?? [join(cwd, "jobs"), join(cwd, ".pi", "jobs")];
  const root =
    packageRoot ?? searchRoots.map((base) => join(base, input)).find((p) => existsSync(p));
  if (!root || !existsSync(join(root, "SKILL.md")))
    throw new Error(`Codemode job not found: ${input}`);
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  const metadata = parseSkillMetadata(join(root, "SKILL.md"));
  const entries = metadata.entry !== undefined ? [metadata.entry] : ["scripts/main.ts", "main.ts"];
  const realRoot = realpathSync(root);
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) throw new Error(`Codemode entry must be a .ts file: ${entry}`);
    const path = resolve(root, entry);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const realPath = realpathSync(path);
    if (realPath.startsWith(realRoot + "/")) {
      const body = skill.startsWith("---") ? skill.replace(/^---[\s\S]*?\n---\s*\n?/, "") : skill;
      return {
        root: realRoot,
        entry: realPath,
        name: metadata.name,
        description: metadata.description,
        handoff: metadata.handoff,
        prompt: body.trim(),
      };
    }
  }
  throw new Error(`No codemode entry found in skill: ${root}`);
}

export function resolveJobEntry(input: string, cwd = process.cwd(), roots?: string[]): string {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  if (input.endsWith(".ts") && existsSync(candidate) && statSync(candidate).isFile())
    return candidate;
  const packageRoot =
    existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : undefined;
  const searchRoots = roots ?? [join(cwd, "jobs"), join(cwd, ".pi", "jobs")];
  const root =
    packageRoot ?? searchRoots.map((base) => join(base, input)).find((p) => existsSync(p));
  if (!root || !existsSync(join(root, "SKILL.md"))) {
    throw new Error(`Codemode job not found: ${input}`);
  }
  const metadata = parseSkillMetadata(join(root, "SKILL.md"));
  const entries = metadata.entry !== undefined ? [metadata.entry] : ["scripts/main.ts", "main.ts"];
  const realRoot = realpathSync(root);
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) throw new Error(`Codemode entry must be a .ts file: ${entry}`);
    const path = resolve(root, entry);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const realPath = realpathSync(path);
    if (realPath.startsWith(realRoot + "/")) return realPath;
  }
  throw new Error(`No codemode entry found in skill: ${root}`);
}

export function renderHandoffPrompt(
  prompt: string,
  result: unknown,
  args: Record<string, string>,
): string {
  const serialized = serializeJobResult(result).trimEnd();
  const json =
    result === undefined
      ? "undefined"
      : JSON.stringify(result, (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        );
  return prompt
    .replaceAll("{{result.json}}", json)
    .replaceAll("{{result}}", serialized)
    .replaceAll("{{args}}", JSON.stringify(args));
}

export function serializeJobResult(value: unknown): string {
  if (value === undefined) return "";
  if (
    typeof value === "bigint" ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return `${String(value)}\n`;
  return `${JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? String(nested) : nested,
  )}\n`;
}

/** Bypass Pi's print-mode stdout takeover and write the product to file descriptor 1. */
export function writeJobStdout(value: string): void {
  if (value) writeSync(1, value);
}

export function readJobEntry(path: string): string {
  return readFileSync(path, "utf8");
}
