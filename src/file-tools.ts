// file-tools.ts — Core file tool implementations (read, write, replace_in_file, apply_patch).
//
// These are host-side implementations that use Node.js fs directly.
// Path validation scopes operations to the project directory unless unrestricted (yolo).

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, normalize, join, sep } from "node:path";

/** Mutable path scope shared with the extension so mode flips take effect without re-registering tools. */
export interface FileScope {
  /** Base directory for relative paths (typically process.cwd() / project root). */
  root: string;
  /**
   * When false, all paths must resolve inside root (default / on mode).
   * When true, absolute paths may resolve anywhere; relative paths still use root (yolo mode).
   */
  unrestricted: boolean;
}

export interface FileToolsOptions {
  /**
   * Project root directory. Used when `scope` is omitted; operations are always scoped
   * (unrestricted: false). Prefer `scope` when the caller needs to flip unrestricted at runtime.
   */
  projectRoot?: string;
  /** Mutable scope object. Read on every call so mode changes apply immediately. */
  scope?: FileScope;
}

export interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteParams {
  path: string;
  content: string;
}

export interface EditParams {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export interface ApplyPatchParams {
  patch: string;
}

function resolveScope(options: FileToolsOptions): FileScope {
  if (options.scope) return options.scope;
  if (options.projectRoot) {
    return { root: options.projectRoot, unrestricted: false };
  }
  throw new Error("createFileTools requires scope or projectRoot");
}

/**
 * Create file tool implementations scoped to a project directory.
 * Pass a mutable `scope` object to flip unrestricted at runtime (yolo mode).
 */
export function createFileTools(options: FileToolsOptions) {
  const scope = resolveScope(options);

  return {
    read(params: ReadParams): string {
      const fullPath = validateAndResolvePath(params.path, scope);
      const content = readFileSync(fullPath, "utf-8");

      // Handle line-based offset/limit
      if (params.offset !== undefined || params.limit !== undefined) {
        const lines = content.split("\n");
        const offset = params.offset ?? 0;
        const limit = params.limit ?? lines.length;

        if (offset < 0 || offset >= lines.length) {
          return "";
        }

        return lines.slice(offset, offset + limit).join("\n");
      }

      return content;
    },

    write(params: WriteParams): void {
      const fullPath = validateAndResolvePath(params.path, scope);

      // Create parent directories if needed
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, params.content, "utf-8");
    },

    apply_patch(params: ApplyPatchParams): string {
      return applyUnifiedPatch(params.patch, scope);
    },

    replace_in_file(params: EditParams): string {
      const fullPath = validateAndResolvePath(params.path, scope);
      let content = readFileSync(fullPath, "utf-8");

      // Track replacement positions to detect overlaps
      const editPositions: Array<{ start: number; end: number; oldText: string; newText: string }> =
        [];

      // First pass: find all positions and validate
      for (const edit of params.edits) {
        const positions = findAllPositions(content, edit.oldText);

        if (positions.length === 0) {
          throw new Error(`oldText not found: "${formatDiagnosticText(edit.oldText)}"`);
        }

        if (positions.length > 1) {
          throw new Error(
            `oldText matches ${positions.length} times, expected exactly 1: "${formatDiagnosticText(edit.oldText)}"`,
          );
        }

        editPositions.push({
          start: positions[0],
          end: positions[0] + edit.oldText.length,
          oldText: edit.oldText,
          newText: edit.newText,
        });
      }

      // Check for overlapping edits
      for (let i = 0; i < editPositions.length; i++) {
        for (let j = i + 1; j < editPositions.length; j++) {
          const a = editPositions[i];
          const b = editPositions[j];
          if (a.start < b.end && b.start < a.end) {
            throw new Error(`Edits overlap: "${a.oldText}" and "${b.oldText}"`);
          }
        }
      }

      // Sort by position (descending) so replacements don't affect earlier indices
      editPositions.sort((a, b) => b.start - a.start);

      const original = content;

      // Apply edits
      for (const edit of editPositions) {
        content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
      }

      writeFileSync(fullPath, content, "utf-8");

      return `Replaced ${params.edits.length} occurrence${params.edits.length === 1 ? "" : "s"} in ${params.path}\n${createUnifiedDiff(params.path, original, content)}`;
    },
  };
}

/**
 * Validate and resolve a user-provided path to an absolute path.
 *
 * When scope.unrestricted is false: reject any path whose lexical or real
 * (symlink-resolved) location is outside the project root. For not-yet-existing
 * targets, the nearest existing ancestor is realpath'd and the remaining segments
 * are re-checked lexically under that real base.
 *
 * When scope.unrestricted is true: absolute paths resolve anywhere; relative paths
 * still resolve against scope.root; no containment check (yolo mode).
 */
function validateAndResolvePath(userPath: string, scope: FileScope): string {
  const resolvedRoot = resolveRealOrNormalize(scope.root);
  const candidate = isAbsolute(userPath)
    ? normalize(userPath)
    : normalize(join(resolvedRoot, userPath));

  if (scope.unrestricted) {
    return resolvePathUnrestricted(candidate);
  }

  // Lexical containment before touching the filesystem (blocks .. traversal).
  assertPathInsideRoot(candidate, resolvedRoot, userPath);

  // Symlink-aware containment: realpath existing prefix, then check final real path.
  const realPath = resolvePathThroughSymlinks(candidate, resolvedRoot, userPath);
  assertPathInsideRoot(realPath, resolvedRoot, userPath);

  return realPath;
}

/** Resolve path without project containment (absolute anywhere; relative already joined to root). */
function resolvePathUnrestricted(candidate: string): string {
  if (existsSync(candidate)) {
    try {
      return realpathSync(candidate);
    } catch {
      return normalize(resolve(candidate));
    }
  }

  // Walk parents until one exists so new files land on the real ancestor path.
  let probe = candidate;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(probe.slice(parent.length).replace(/^[\\/]/, ""));
    probe = parent;
  }

  if (!existsSync(probe)) {
    return normalize(resolve(candidate));
  }

  let realBase: string;
  try {
    realBase = realpathSync(probe);
  } catch {
    return normalize(resolve(candidate));
  }

  return missing.length > 0 ? join(realBase, ...missing) : realBase;
}

function resolveRealOrNormalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return normalize(absolute);
  }
}

/**
 * Walk from the candidate up to an existing ancestor, realpath that ancestor,
 * then rejoin the missing tail. Rejects if any intermediate symlink escapes.
 */
function resolvePathThroughSymlinks(
  candidate: string,
  resolvedRoot: string,
  userPath: string,
): string {
  // If the full path exists (file, dir, or symlink), realpath the whole thing.
  if (existsSync(candidate)) {
    try {
      return realpathSync(candidate);
    } catch {
      // Broken symlink or unreadable — treat as outside / invalid.
      throw new Error(`Path outside project: ${userPath}`);
    }
  }

  // Walk parents until one exists (or we hit filesystem root).
  let probe = candidate;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(probe.slice(parent.length).replace(/^[\\/]/, ""));
    probe = parent;
  }

  if (!existsSync(probe)) {
    // Nothing on disk — fall back to lexical candidate (already checked).
    return candidate;
  }

  // If the deepest existing node is a symlink, realpath it (may escape).
  let realBase: string;
  try {
    realBase = realpathSync(probe);
  } catch {
    throw new Error(`Path outside project: ${userPath}`);
  }
  assertPathInsideRoot(realBase, resolvedRoot, userPath);

  const rebuilt = missing.length > 0 ? join(realBase, ...missing) : realBase;
  assertPathInsideRoot(rebuilt, resolvedRoot, userPath);
  return rebuilt;
}

/** Platform-correct containment: relative path must not escape and must not be absolute. */
function assertPathInsideRoot(target: string, root: string, userPath: string): void {
  const resolvedTarget = normalize(resolve(target));
  const resolvedRoot = normalize(resolve(root));
  if (resolvedTarget === resolvedRoot) return;

  const rel = relative(resolvedRoot, resolvedTarget);
  // Outside: relative is empty with different roots, absolute, or climbs with ..
  if (
    rel === "" ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Path outside project: ${userPath}`);
  }
}

/**
 * Find all starting positions of a substring in a string.
 */
function findAllPositions(content: string, search: string): number[] {
  const positions: number[] = [];
  let pos = 0;

  while ((pos = content.indexOf(search, pos)) !== -1) {
    positions.push(pos);
    pos += 1;
  }

  return positions;
}

interface ParsedFilePatch {
  path: string;
  hunks: ParsedHunk[];
  delete?: boolean;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  lines: string[];
}

function applyUnifiedPatch(patch: string, scope: FileScope): string {
  const files = parsePatch(patch);
  if (files.length === 0) throw new Error("No file patches found in unified diff");

  const prepared: Array<{
    file: ParsedFilePatch;
    fullPath: string;
    original: string;
    updated: string;
  }> = [];
  const statuses: string[] = [];
  // Resolve and validate every path before touching any file.
  const resolved = files.map((file) => ({
    file,
    fullPath: validateAndResolvePath(file.path, scope),
  }));
  for (let index = 0; index < resolved.length; index++) {
    const { file, fullPath } = resolved[index];
    const original = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "";
    try {
      if (file.delete) {
        if (!existsSync(fullPath)) throw new Error("delete target is missing");
      }
      const updated = file.delete ? "" : applyFilePatch(original, file);
      if (
        !file.delete &&
        updated === original &&
        file.hunks.some((h) => h.lines.some((l) => /^[+-]/.test(l)))
      ) {
        throw new Error(`Patch for ${file.path} contained changes but left the file unchanged`);
      }
      prepared.push({ file, fullPath, original, updated });
      statuses.push(`✓ ${file.path} — ok in memory (not written)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push(`✗ ${file.path} — ${formatPatchFailure(message, file, original)}`);
      for (const rest of resolved.slice(index + 1))
        statuses.push(`○ ${rest.file.path} — not attempted`);
      throw new Error(
        `✗ apply_patch failed (${files.length} files in patch)\n${statuses.join("\n")}`,
      );
    }
  }

  const diffs: string[] = [];
  for (const { file, fullPath, original, updated } of prepared) {
    if (file.delete) rmSync(fullPath);
    else {
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, updated, "utf-8");
    }
    diffs.push(createUnifiedDiff(file.path, original, updated));
  }

  return `Applied patch to ${files.length} file${files.length === 1 ? "" : "s"}\n${diffs.join("\n")}`;
}

function parsePatch(patch: string): ParsedFilePatch[] {
  return patch.trimStart().startsWith("*** Begin Patch")
    ? parseBeginPatch(patch)
    : parseUnifiedPatch(patch);
}

function parseBeginPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | undefined;
  let currentHunk: ParsedHunk | undefined;

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      current = { path: line.slice("*** Add File: ".length).trim(), hunks: [] };
      currentHunk = { oldStart: 0, oldCount: 0, lines: [] };
      current.hunks.push(currentHunk);
      files.push(current);
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      current = { path: line.slice("*** Delete File: ".length).trim(), hunks: [], delete: true };
      currentHunk = undefined;
      files.push(current);
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      current = { path: line.slice("*** Update File: ".length).trim(), hunks: [] };
      files.push(current);
      currentHunk = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      currentHunk = { oldStart: 0, oldCount: 0, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (line.startsWith("*** ")) {
      currentHunk = undefined;
      continue;
    }
    if (currentHunk && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
      currentHunk.lines.push(line);
    }
  }

  if (files.some((file) => !file.delete && file.hunks.length === 0)) {
    throw new Error("No parseable hunks found in Begin Patch input");
  }
  return files;
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.split("\n");
  const files: ParsedFilePatch[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("--- ")) {
      i++;
      continue;
    }
    const oldPath = parsePatchPath(lines[i].slice(4));
    i++;
    if (i >= lines.length || !lines[i].startsWith("+++ ")) {
      throw new Error(`Invalid unified diff: expected +++ after --- ${oldPath}`);
    }
    const newPath = parsePatchPath(lines[i].slice(4));
    const path = newPath === "/dev/null" ? oldPath : newPath;
    const file: ParsedFilePatch = { path, hunks: [], delete: newPath === "/dev/null" };
    i++;

    while (i < lines.length && !lines[i].startsWith("--- ")) {
      const header = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!header) {
        i++;
        continue;
      }
      const hunk: ParsedHunk = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? 1),
        lines: [],
      };
      i++;
      while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("--- ")) {
        if (lines[i] !== "" || i < lines.length - 1) hunk.lines.push(lines[i]);
        i++;
      }
      file.hunks.push(hunk);
    }
    if (!file.delete && file.hunks.length === 0) {
      throw new Error(`No parseable hunks found for ${file.path}`);
    }
    files.push(file);
  }

  return files;
}

function parsePatchPath(raw: string): string {
  const path = raw.trim().split(/\s+/)[0];
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

function applyFilePatch(original: string, patch: ParsedFilePatch): string {
  const hasTrailingNewline = original.endsWith("\n");
  const originalLines = original === "" ? [] : original.replace(/\n$/, "").split("\n");
  const result: string[] = [];
  let cursor = 0;

  for (let hunkIndex = 0; hunkIndex < patch.hunks.length; hunkIndex++) {
    const hunk = patch.hunks[hunkIndex];
    let start: number;
    try {
      start = findHunkStart(originalLines, hunk, cursor, patch.path, original);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} [hunk ${hunkIndex + 1} cursor ${cursor}]`);
    }
    if (start < cursor)
      throw new Error(
        `Hunk failed for ${patch.path} at -${hunk.oldStart},${hunk.oldCount}: overlaps previous hunk`,
      );
    result.push(...originalLines.slice(cursor, start));
    let pos = start;

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || marker === "-") {
        if (originalLines[pos] !== text) {
          const nearby = nearbyLines(originalLines, pos);
          throw new Error(
            `Hunk failed for ${patch.path} at -${hunk.oldStart},${hunk.oldCount}: expected ${JSON.stringify(text)} but found ${JSON.stringify(originalLines[pos] ?? "<EOF>")}; nearby ${nearby} [hunk ${hunkIndex + 1} cursor ${pos}]`,
          );
        }
        if (marker === " ") result.push(text);
        pos++;
      } else if (marker === "+") {
        result.push(text);
      } else if (line.startsWith("\\ No newline at end of file")) {
        // Metadata line; ignore for MVP.
      } else {
        throw new Error(`Invalid hunk line for ${patch.path}: ${JSON.stringify(line)}`);
      }
    }
    cursor = pos;
  }

  result.push(...originalLines.slice(cursor));
  const next = result.join("\n");
  return hasTrailingNewline || patch.hunks.some((h) => h.lines.some((l) => l.startsWith("+")))
    ? next + "\n"
    : next;
}

function findHunkStart(
  originalLines: string[],
  hunk: ParsedHunk,
  cursor: number,
  path: string,
  original: string,
): number {
  const expected = hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));

  if (original.includes("\r\n") && expected.some((line) => !line.includes("\r"))) {
    throw new Error(`Hunk failed for ${path}: file uses CRLF line endings; patch uses LF`);
  }

  const exactStart = hunk.oldStart === 0 ? -1 : hunk.oldStart - 1;
  if (exactStart >= cursor && matchesExpected(originalLines, expected, exactStart)) {
    return exactStart;
  }

  if (expected.length === 0) return Math.max(cursor, exactStart);

  const matches = findContextMatches(originalLines, expected, cursor);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Hunk failed for ${path} at -${hunk.oldStart},${hunk.oldCount}: ambiguous context matches at lines ${matches.map((match) => match + 1).join(", ")}`,
    );
  }

  throw new Error(
    `Hunk failed for ${path} at -${hunk.oldStart},${hunk.oldCount}: context not found; nearby ${nearbyLines(originalLines, Math.max(cursor, exactStart))}`,
  );
}

function matchesExpected(lines: string[], expected: string[], start: number): boolean {
  return (
    start >= 0 &&
    start + expected.length <= lines.length &&
    expected.every((line, offset) => lines[start + offset] === line)
  );
}

function findContextMatches(lines: string[], expected: string[], cursor: number): number[] {
  const matches: number[] = [];
  for (let start = cursor; start <= lines.length - expected.length; start++) {
    if (matchesExpected(lines, expected, start)) matches.push(start);
  }
  return matches;
}

function nearbyLines(lines: string[], index: number): string {
  if (lines.length === 0) return "<empty file>";
  const start = Math.max(0, Math.min(index, lines.length - 1) - 2);
  const end = Math.min(lines.length, start + 5);
  return lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}:${JSON.stringify(line)}`)
    .join(" | ");
}

function formatPatchFailure(message: string, hunk: ParsedFilePatch, original: string): string {
  const reason = /ambiguous/i.test(message)
    ? "ambiguous"
    : /CRLF|line ending/i.test(message)
      ? "CRLF"
      : /overlap/i.test(message)
        ? "overlap"
        : /not found|expected/i.test(message)
          ? "context not found"
          : "parse";
  const explicitHunk = message.match(/\[hunk (\d+) cursor (\d+)\]/);
  const hunkNumber = explicitHunk
    ? Number(explicitHunk[1])
    : Math.max(
        1,
        hunk.hunks.findIndex((item) => message.includes(`-${item.oldStart},${item.oldCount}`)) + 1,
      );
  const failedHunk = hunk.hunks[hunkNumber - 1] ?? hunk.hunks[0];
  const sought =
    failedHunk?.lines.filter((line) => /^[ -]/.test(line)).map((line) => line.slice(1)) ?? [];
  const lines = original === "" ? [] : original.replace(/\n$/, "").split("\n");
  const center = explicitHunk
    ? Number(explicitHunk[2])
    : Math.max(0, (failedHunk?.oldStart ?? 1) - 1);
  const nearbyStart = Math.max(0, center - 2);
  const nearby = lines.slice(nearbyStart, center + 3);
  return `hunk ${hunkNumber}: ${reason}: ${message}\n  sought:\n${sought.map((line, i) => `    ${i + 1}: ${JSON.stringify(line)}`).join("\n")}\n  nearby:\n${nearby.map((line, i) => `    ${nearbyStart + i + 1}: ${JSON.stringify(line)}`).join("\n")}`;
}

function formatDiagnosticText(text: string): string {
  const maxLength = 200;
  return text.length > maxLength ? `${text.slice(0, maxLength)}... (length ${text.length})` : text;
}

function createUnifiedDiff(path: string, original: string, updated: string): string {
  const originalLines = splitDiffLines(original);
  const updatedLines = splitDiffLines(updated);
  const context = 1;

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < updatedLines.length &&
    originalLines[prefix] === updatedLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < updatedLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] ===
      updatedLines[updatedLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldStart = Math.max(0, prefix - context);
  const newStart = Math.max(0, prefix - context);
  const oldEnd = Math.min(originalLines.length, originalLines.length - suffix + context);
  const newEnd = Math.min(updatedLines.length, updatedLines.length - suffix + context);
  const removedStart = prefix;
  const removedEnd = originalLines.length - suffix;
  const addedStart = prefix;
  const addedEnd = updatedLines.length - suffix;

  const diffLines = [
    `--- a/${path.replace(/^\/+/, "")}`,
    `+++ b/${path.replace(/^\/+/, "")}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
  ];

  for (let i = oldStart; i < removedStart; i++) diffLines.push(` ${originalLines[i]}`);
  for (let i = removedStart; i < removedEnd; i++) diffLines.push(`-${originalLines[i]}`);
  for (let i = addedStart; i < addedEnd; i++) diffLines.push(`+${updatedLines[i]}`);
  for (let i = removedEnd; i < oldEnd; i++) diffLines.push(` ${originalLines[i]}`);

  return diffLines.join("\n");
}

function splitDiffLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\n$/, "").split("\n");
}
