import { existsSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface JobPackage {
  root: string;
  entry: string;
  name?: string;
  description?: string;
}

function parseSkillMetadata(path: string): { name?: string; description?: string; entry?: string } {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const values: Record<string, string> = {};
  let section = "";
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^(name|description|codemode-entry):\s*(.*)$/.exec(line.trim());
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
  return { name: values.name, description: values.description, entry: values.entry };
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
