// file-tools.ts — Core file tool implementations (read, write, replace_in_file, apply_patch).
//
// These are host-side implementations that use Node.js fs directly.
// Path validation ensures all operations stay within the project directory.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, normalize, join } from "node:path";

export interface FileToolsOptions {
  /** Project root directory - all file operations are scoped to this directory */
  projectRoot: string;
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

/**
 * Create file tool implementations scoped to a project directory.
 */
export function createFileTools(options: FileToolsOptions) {
  const { projectRoot } = options;

  return {
    read(params: ReadParams): string {
      const fullPath = validateAndResolvePath(params.path, projectRoot);
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
      const fullPath = validateAndResolvePath(params.path, projectRoot);

      // Create parent directories if needed
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, params.content, "utf-8");
    },

    apply_patch(params: ApplyPatchParams): string {
      return applyUnifiedPatch(params.patch, projectRoot);
    },

    replace_in_file(params: EditParams): string {
      const fullPath = validateAndResolvePath(params.path, projectRoot);
      let content = readFileSync(fullPath, "utf-8");

      // Track replacement positions to detect overlaps
      const editPositions: Array<{ start: number; end: number; oldText: string; newText: string }> =
        [];

      // First pass: find all positions and validate
      for (const edit of params.edits) {
        const positions = findAllPositions(content, edit.oldText);

        if (positions.length === 0) {
          throw new Error(`oldText not found: "${edit.oldText}"`);
        }

        if (positions.length > 1) {
          throw new Error(
            `oldText matches ${positions.length} times, expected exactly 1: "${edit.oldText}"`,
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

      // Apply edits
      for (const edit of editPositions) {
        content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
      }

      writeFileSync(fullPath, content, "utf-8");

      return `Replaced ${params.edits.length} occurrence${params.edits.length === 1 ? "" : "s"} in ${params.path}`;
    },
  };
}

/**
 * Validate and resolve a user-provided path to an absolute path within the project.
 * Throws if the path attempts to escape the project directory.
 */
function validateAndResolvePath(userPath: string, projectRoot: string): string {
  // Normalize the project root
  const normalizedRoot = normalize(resolve(projectRoot));

  // Resolve the user path
  let fullPath: string;
  if (isAbsolute(userPath)) {
    fullPath = normalize(userPath);
  } else {
    fullPath = normalize(join(normalizedRoot, userPath));
  }

  // Ensure the resolved path is within the project root
  const relativePath = relative(normalizedRoot, fullPath);

  // Check for path traversal attempts
  if (relativePath.startsWith("..") || relativePath.startsWith("." + "/..")) {
    throw new Error(`Path outside project: ${userPath}`);
  }

  // Double-check by resolving and comparing
  const resolvedPath = resolve(fullPath);
  const resolvedRoot = resolve(normalizedRoot);

  if (!resolvedPath.startsWith(resolvedRoot + "/") && resolvedPath !== resolvedRoot) {
    throw new Error(`Path outside project: ${userPath}`);
  }

  return fullPath;
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
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  lines: string[];
}

function applyUnifiedPatch(patch: string, projectRoot: string): string {
  const files = parseUnifiedPatch(patch);
  if (files.length === 0) throw new Error("No file patches found in unified diff");

  for (const file of files) {
    const fullPath = validateAndResolvePath(file.path, projectRoot);
    const original = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "";
    const updated = applyFilePatch(original, file);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, updated, "utf-8");
  }

  return `Applied patch to ${files.length} file${files.length === 1 ? "" : "s"}`;
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
    const file: ParsedFilePatch = { path, hunks: [] };
    i++;

    while (i < lines.length && !lines[i].startsWith("--- ")) {
      const header = lines[i].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      if (!header) {
        i++;
        continue;
      }
      const hunk: ParsedHunk = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2]),
        lines: [],
      };
      i++;
      while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("--- ")) {
        if (lines[i] !== "" || i < lines.length - 1) hunk.lines.push(lines[i]);
        i++;
      }
      file.hunks.push(hunk);
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

  for (const hunk of patch.hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
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
          throw new Error(
            `Hunk failed for ${patch.path} at -${hunk.oldStart},${hunk.oldCount}: expected ${JSON.stringify(text)} but found ${JSON.stringify(originalLines[pos] ?? "<EOF>")}`,
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
