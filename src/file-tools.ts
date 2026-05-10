// file-tools.ts — Core file tool implementations (read, write, edit).
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

    edit(params: EditParams): string {
      const fullPath = validateAndResolvePath(params.path, projectRoot);
      let content = readFileSync(fullPath, "utf-8");

      // Track edit positions to detect overlaps
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
