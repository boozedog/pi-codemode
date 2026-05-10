import type { JSONSchema7 } from "json-schema";

export type OperationEffect = "read" | "write" | "external";

export interface CliOperationDefinition {
  effect: OperationEffect;
  description: string;
  inputSchema: JSONSchema7;
  params: string[];
  docs: string;
  toArgv(args: Record<string, unknown>): string[];
}

export const DEFAULT_GH_ISSUE_VIEW_JSON = [
  "number",
  "title",
  "state",
  "url",
  "body",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
];
export const DEFAULT_GH_ISSUE_LIST_JSON = [
  "number",
  "title",
  "state",
  "url",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
];
export const DEFAULT_GH_PR_VIEW_JSON = [
  "number",
  "title",
  "state",
  "url",
  "body",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
  "headRefName",
  "baseRefName",
  "isDraft",
  "mergeable",
];
export const DEFAULT_GH_PR_LIST_JSON = [
  "number",
  "title",
  "state",
  "url",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "comments",
  "headRefName",
  "baseRefName",
  "isDraft",
];

const s = (description?: string): JSONSchema7 => ({ type: "string", description });
const b = (description?: string): JSONSchema7 => ({ type: "boolean", description });
const n = (description?: string): JSONSchema7 => ({ type: "integer", description });
const sa = (description?: string): JSONSchema7 => ({
  type: "array",
  items: { type: "string" },
  description,
});
const obj = (properties: Record<string, JSONSchema7>, required: string[] = []): JSONSchema7 => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const stateSchema: JSONSchema7 = {
  type: "string",
  enum: ["open", "closed", "all"],
  description: "Issue or pull request state.",
};
const findTypeSchema: JSONSchema7 = {
  type: "string",
  enum: ["file", "directory"],
  description: "Restrict results to files or directories.",
};

export const CLI_OPERATIONS: Record<string, Record<string, CliOperationDefinition>> = {
  git: {
    status: {
      effect: "read",
      description: "Git status. Show working tree status for the current repository.",
      docs: "Show working tree status for the current repository.",
      params: ["short", "branch"],
      inputSchema: obj({ short: b("Use short output."), branch: b("Show branch information.") }),
      toArgv: (args) => [
        "status",
        ...(args.short ? ["--short"] : []),
        ...(args.branch ? ["--branch"] : []),
      ],
    },
    branch: {
      effect: "read",
      description: "Git branch. List branches or show the current branch.",
      docs: "List branches or show the current branch.",
      params: ["showCurrent"],
      inputSchema: obj({ showCurrent: b("Print only the current branch name.") }),
      toArgv: (args) => ["branch", ...(args.showCurrent ? ["--show-current"] : [])],
    },
  },
  gh: {
    issueView: {
      effect: "external",
      description: "GitHub issue view. View a GitHub issue by number.",
      docs: `View a GitHub issue by number. Defaults to JSON output with ${DEFAULT_GH_ISSUE_VIEW_JSON.join(",")}. Pass json?: string[] to override returned fields.`,
      params: ["number", "repo", "json", "github", "issue"],
      inputSchema: obj(
        {
          number: n("Issue number."),
          repo: s("Repository in OWNER/REPO format."),
          json: sa("Fields to return as JSON."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "issue",
        "view",
        requiredNumber(args, "number"),
        ...repo(args),
        ...json(args, DEFAULT_GH_ISSUE_VIEW_JSON),
      ],
    },
    issueList: {
      effect: "external",
      description: "GitHub issue list. List GitHub issues.",
      docs: `List GitHub issues. Defaults to JSON output with ${DEFAULT_GH_ISSUE_LIST_JSON.join(",")}. Pass json?: string[] to override returned fields.`,
      params: ["repo", "state", "limit", "json", "github", "issue"],
      inputSchema: obj({
        repo: s("Repository in OWNER/REPO format."),
        state: stateSchema,
        limit: n("Maximum number of issues to fetch."),
        json: sa("Fields to return as JSON."),
      }),
      toArgv: (args) => [
        "issue",
        "list",
        ...repo(args),
        ...state(args),
        ...limit(args),
        ...json(args, DEFAULT_GH_ISSUE_LIST_JSON),
      ],
    },
    prView: {
      effect: "external",
      description: "GitHub pull request view. View a GitHub pull request by number.",
      docs: `View a GitHub pull request by number. Defaults to JSON output with ${DEFAULT_GH_PR_VIEW_JSON.join(",")}. Pass json?: string[] to override returned fields.`,
      params: ["number", "repo", "json", "github", "pull", "request", "pr"],
      inputSchema: obj(
        {
          number: n("Pull request number."),
          repo: s("Repository in OWNER/REPO format."),
          json: sa("Fields to return as JSON."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "pr",
        "view",
        requiredNumber(args, "number"),
        ...repo(args),
        ...json(args, DEFAULT_GH_PR_VIEW_JSON),
      ],
    },
    prList: {
      effect: "external",
      description: "GitHub pull request list. List GitHub pull requests.",
      docs: `List GitHub pull requests. Defaults to JSON output with ${DEFAULT_GH_PR_LIST_JSON.join(",")}. Pass json?: string[] to override returned fields.`,
      params: ["repo", "state", "limit", "json", "github", "pull", "request", "pr"],
      inputSchema: obj({
        repo: s("Repository in OWNER/REPO format."),
        state: stateSchema,
        limit: n("Maximum number of pull requests to fetch."),
        json: sa("Fields to return as JSON."),
      }),
      toArgv: (args) => [
        "pr",
        "list",
        ...repo(args),
        ...state(args),
        ...limit(args),
        ...json(args, DEFAULT_GH_PR_LIST_JSON),
      ],
    },
  },
  rg: {
    search: {
      effect: "read",
      description: "Ripgrep search. Search file contents by pattern.",
      docs: "Search file contents by pattern using ripgrep.",
      params: ["pattern", "paths", "glob", "ignoreCase", "lineNumber", "hidden", "maxCount"],
      inputSchema: obj(
        {
          pattern: s("Search pattern."),
          paths: sa("Paths to search."),
          glob: sa("Glob filters."),
          ignoreCase: b("Case-insensitive search."),
          lineNumber: b("Show line numbers."),
          hidden: b("Search hidden files."),
          maxCount: n("Limit matches per file."),
        },
        ["pattern"],
      ),
      toArgv: (args) => [
        ...(args.ignoreCase ? ["--ignore-case"] : []),
        ...(args.lineNumber ? ["--line-number"] : []),
        ...(args.hidden ? ["--hidden"] : []),
        ...numberFlag("--max-count", args.maxCount),
        ...stringArrayFlag("--glob", args.glob),
        requiredString(args, "pattern"),
        ...stringArray(args.paths),
      ],
    },
  },
  find: {
    files: {
      effect: "read",
      description: "Find files. Search for files by path, name, max depth, or type.",
      docs: "Search for files by path, name, max depth, or type.",
      params: ["path", "name", "maxDepth", "type", "file", "directory"],
      inputSchema: obj({
        path: s("Starting path."),
        name: s("Name pattern."),
        maxDepth: n("Maximum directory depth."),
        type: findTypeSchema,
      }),
      toArgv: (args) => [
        stringArg(args.path, "."),
        ...numberFlag("-maxdepth", args.maxDepth),
        ...(args.name === undefined ? [] : ["-name", stringArg(args.name, "", "name")]),
        ...findType(args.type),
      ],
    },
  },
  grep: {
    search: {
      effect: "read",
      description: "Grep search. Search file contents by pattern.",
      docs: "Search file contents by pattern using grep.",
      params: ["pattern", "paths", "recursive", "ignoreCase"],
      inputSchema: obj(
        {
          pattern: s("Search pattern."),
          paths: sa("Paths to search."),
          recursive: b("Search recursively."),
          ignoreCase: b("Case-insensitive search."),
        },
        ["pattern"],
      ),
      toArgv: (args) => [
        ...(args.recursive ? ["-R"] : []),
        ...(args.ignoreCase ? ["-i"] : []),
        requiredString(args, "pattern"),
        ...stringArray(args.paths),
      ],
    },
  },
  ls: {
    list: {
      effect: "read",
      description: "List directory contents.",
      docs: "List directory contents.",
      params: ["path", "all", "long"],
      inputSchema: obj({
        path: s("Path to list."),
        all: b("Include hidden entries."),
        long: b("Use long listing format."),
      }),
      toArgv: (args) => [
        ...(args.all ? ["-a"] : []),
        ...(args.long ? ["-l"] : []),
        ...(args.path === undefined ? [] : [stringArg(args.path, ".")]),
      ],
    },
  },
};

export function getCliOperationDefinition(
  tool: string,
  operation: string,
): CliOperationDefinition | undefined {
  return CLI_OPERATIONS[tool]?.[operation];
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}
function requiredNumber(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${key} must be an integer`);
  return String(value);
}
function stringArg(value: unknown, fallback: string, key = "path"): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}
function stringArray(value: unknown, key = "paths"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Error(`${key} must be an array of strings`);
  return value;
}
function numberFlag(flag: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${flag} must be an integer`);
  return [flag, String(value)];
}
function stringArrayFlag(flag: string, value: unknown): string[] {
  return stringArray(value, flag).flatMap((v) => [flag, v]);
}
function repo(args: Record<string, unknown>): string[] {
  if (args.repo === undefined) return [];
  if (typeof args.repo !== "string") throw new Error("repo must be a string");
  return ["--repo", args.repo];
}
function json(args: Record<string, unknown>, defaults: string[] = []): string[] {
  if (args.json === undefined && defaults.length === 0) return [];
  const values = args.json === undefined ? defaults : stringArray(args.json, "json");
  if (values.length === 0 || values.some((v) => v.length === 0))
    throw new Error("json must be a non-empty array of strings");
  return ["--json", values.join(",")];
}
function state(args: Record<string, unknown>): string[] {
  if (args.state === undefined) return [];
  if (!["open", "closed", "all"].includes(String(args.state)))
    throw new Error("state must be one of open, closed, all");
  return ["--state", String(args.state)];
}
function limit(args: Record<string, unknown>): string[] {
  if (args.limit === undefined) return [];
  if (
    typeof args.limit !== "number" ||
    !Number.isInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > 1000
  )
    throw new Error("limit must be an integer between 1 and 1000");
  return ["--limit", String(args.limit)];
}
function findType(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === "file") return ["-type", "f"];
  if (value === "directory") return ["-type", "d"];
  throw new Error("type must be one of file, directory");
}
