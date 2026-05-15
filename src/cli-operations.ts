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
export const DEFAULT_GH_PR_CHECKS_JSON = [
  "name",
  "state",
  "conclusion",
  "link",
  "startedAt",
  "completedAt",
  "workflow",
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
const issueCloseStateReasonSchema: JSONSchema7 = {
  type: "string",
  enum: ["completed", "not planned"],
  description: "Reason for closing the issue.",
};
const findTypeSchema: JSONSchema7 = {
  type: "string",
  enum: ["file", "directory"],
  description: "Restrict results to files or directories.",
};
const resetModeSchema: JSONSchema7 = {
  type: "string",
  enum: ["soft", "mixed", "hard"],
  description: "Reset mode.",
};
const stashCommandSchema: JSONSchema7 = {
  type: "string",
  enum: ["push", "pop", "apply", "list", "drop", "clear"],
  description: "Stash subcommand.",
};
const vitestReporterSchema: JSONSchema7 = {
  type: "string",
  enum: ["default", "verbose", "dot", "json", "junit"],
  description: "Vitest reporter.",
};
const oxlintDenySchema: JSONSchema7 = {
  type: "string",
  enum: ["warnings"],
  description: "Diagnostic level to deny.",
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
    diff: {
      effect: "read",
      description: "Git diff. Show changes in the working tree or index.",
      docs: "Show changes in the working tree or index.",
      params: ["staged", "stat", "nameOnly", "ref", "paths"],
      inputSchema: obj({
        staged: b("Show staged changes."),
        stat: b("Show diffstat."),
        nameOnly: b("Show only changed file names."),
        ref: s("Commit/range to diff."),
        paths: sa("Restrict diff to paths."),
      }),
      toArgv: (args) => [
        "diff",
        ...(args.staged ? ["--cached"] : []),
        ...(args.stat ? ["--stat"] : []),
        ...(args.nameOnly ? ["--name-only"] : []),
        ...optionalString(args.ref, "ref"),
        ...pathspec(args.paths),
      ],
    },
    log: {
      effect: "read",
      description: "Git log. Show commit history.",
      docs: "Show commit history.",
      params: ["limit", "oneline", "stat", "paths"],
      inputSchema: obj({
        limit: n("Maximum number of commits."),
        oneline: b("Use one-line format."),
        stat: b("Show diffstat."),
        paths: sa("Restrict history to paths."),
      }),
      toArgv: (args) => [
        "log",
        ...numberFlag("--max-count", args.limit),
        ...(args.oneline ? ["--oneline"] : []),
        ...(args.stat ? ["--stat"] : []),
        ...pathspec(args.paths),
      ],
    },
    show: {
      effect: "read",
      description: "Git show. Show an object such as a commit.",
      docs: "Show an object such as a commit.",
      params: ["ref", "stat", "nameOnly"],
      inputSchema: obj({
        ref: s("Object or revision to show."),
        stat: b("Show diffstat."),
        nameOnly: b("Show only changed file names."),
      }),
      toArgv: (args) => [
        "show",
        ...(args.stat ? ["--stat"] : []),
        ...(args.nameOnly ? ["--name-only"] : []),
        ...optionalString(args.ref, "ref"),
      ],
    },
    remote: {
      effect: "read",
      description: "Git remote. List configured remotes.",
      docs: "List configured remotes.",
      params: ["verbose"],
      inputSchema: obj({ verbose: b("Show remote URLs.") }),
      toArgv: (args) => ["remote", ...(args.verbose ? ["-v"] : [])],
    },
    revParse: {
      effect: "read",
      description: "Git rev-parse. Resolve revisions and repository paths.",
      docs: "Resolve revisions and repository paths.",
      params: ["ref", "showTopLevel", "isInsideWorkTree"],
      inputSchema: obj({
        ref: s("Revision to resolve."),
        showTopLevel: b("Show repository root."),
        isInsideWorkTree: b("Print whether cwd is inside a work tree."),
      }),
      toArgv: (args) => [
        "rev-parse",
        ...(args.showTopLevel ? ["--show-toplevel"] : []),
        ...(args.isInsideWorkTree ? ["--is-inside-work-tree"] : []),
        ...optionalString(args.ref, "ref"),
      ],
    },
    add: {
      effect: "write",
      description: "Git add. Stage file contents for the next commit.",
      docs: "Stage file contents for the next commit.",
      params: ["paths", "all", "patch"],
      inputSchema: obj({
        paths: sa("Paths to stage."),
        all: b("Stage all changes."),
        patch: b("Interactively choose hunks."),
      }),
      toArgv: (args) => [
        "add",
        ...(args.all ? ["--all"] : []),
        ...(args.patch ? ["--patch"] : []),
        ...pathspec(args.paths),
      ],
    },
    commit: {
      effect: "write",
      description: "Git commit. Record staged changes in the repository.",
      docs: "Record staged changes in the repository.",
      params: ["message", "all", "amend"],
      inputSchema: obj(
        {
          message: s("Commit message."),
          all: b("Stage tracked files before committing."),
          amend: b("Amend the previous commit."),
        },
        ["message"],
      ),
      toArgv: (args) => [
        "commit",
        ...(args.all ? ["--all"] : []),
        ...(args.amend ? ["--amend"] : []),
        "-m",
        requiredString(args, "message"),
      ],
    },
    push: {
      effect: "external",
      description: "Git push. Update remote refs using local refs.",
      docs: "Update remote refs using local refs.",
      params: ["remote", "branch", "setUpstream", "tags"],
      inputSchema: obj({
        remote: s("Remote name."),
        branch: s("Branch or refspec to push."),
        setUpstream: b("Set upstream tracking."),
        tags: b("Push tags."),
      }),
      toArgv: (args) => [
        "push",
        ...(args.setUpstream ? ["--set-upstream"] : []),
        ...(args.tags ? ["--tags"] : []),
        ...optionalString(args.remote, "remote"),
        ...optionalString(args.branch, "branch"),
      ],
    },
    pull: {
      effect: "external",
      description: "Git pull. Fetch from and integrate with another repository or branch.",
      docs: "Fetch from and integrate with another repository or branch.",
      params: ["remote", "branch", "rebase", "ffOnly"],
      inputSchema: obj({
        remote: s("Remote name."),
        branch: s("Branch to pull."),
        rebase: b("Rebase instead of merge."),
        ffOnly: b("Abort unless fast-forward is possible."),
      }),
      toArgv: (args) => [
        "pull",
        ...(args.rebase ? ["--rebase"] : []),
        ...(args.ffOnly ? ["--ff-only"] : []),
        ...optionalString(args.remote, "remote"),
        ...optionalString(args.branch, "branch"),
      ],
    },
    switch: {
      effect: "write",
      description: "Git switch. Switch branches.",
      docs: "Switch branches.",
      params: ["branch", "create", "detach"],
      inputSchema: obj(
        {
          branch: s("Branch to switch to."),
          create: b("Create a new branch."),
          detach: b("Detach HEAD at branch/ref."),
        },
        ["branch"],
      ),
      toArgv: (args) => [
        "switch",
        ...(args.create ? ["--create"] : []),
        ...(args.detach ? ["--detach"] : []),
        requiredString(args, "branch"),
      ],
    },
    checkout: {
      effect: "write",
      description: "Git checkout. Switch branches or restore paths.",
      docs: "Switch branches or restore working tree paths.",
      params: ["branch", "paths"],
      inputSchema: obj({ branch: s("Branch or tree-ish."), paths: sa("Paths to check out.") }),
      toArgv: (args) => [
        "checkout",
        ...optionalString(args.branch, "branch"),
        ...pathspec(args.paths),
      ],
    },
    restore: {
      effect: "write",
      description: "Git restore. Restore working tree files.",
      docs: "Restore working tree files.",
      params: ["paths", "staged", "source"],
      inputSchema: obj({
        paths: sa("Paths to restore."),
        staged: b("Restore the index."),
        source: s("Tree-ish to restore from."),
      }),
      toArgv: (args) => [
        "restore",
        ...(args.staged ? ["--staged"] : []),
        ...stringFlag("--source", args.source, "source"),
        ...pathspec(args.paths),
      ],
    },
    reset: {
      effect: "write",
      description: "Git reset. Reset current HEAD to a state.",
      docs: "Reset current HEAD to a state.",
      params: ["mode", "ref", "paths"],
      inputSchema: obj({
        mode: resetModeSchema,
        ref: s("Commit to reset to."),
        paths: sa("Paths to reset."),
      }),
      toArgv: (args) => [
        "reset",
        ...resetMode(args.mode),
        ...optionalString(args.ref, "ref"),
        ...pathspec(args.paths),
      ],
    },
    stash: {
      effect: "write",
      description: "Git stash. Stash or apply working tree changes.",
      docs: "Stash, list, apply, pop, drop, or clear working tree changes.",
      params: ["command", "message", "stash", "includeUntracked"],
      inputSchema: obj({
        command: stashCommandSchema,
        message: s("Stash message for push."),
        stash: s("Stash reference."),
        includeUntracked: b("Include untracked files for push."),
      }),
      toArgv: (args) => [
        "stash",
        ...stashCommand(args.command),
        ...(args.includeUntracked ? ["--include-untracked"] : []),
        ...stringFlag("-m", args.message, "message"),
        ...optionalString(args.stash, "stash"),
      ],
    },
    tag: {
      effect: "write",
      description: "Git tag. Create, list, delete, or verify tags.",
      docs: "Create, list, delete, or verify tags.",
      params: ["name", "message", "delete", "list"],
      inputSchema: obj({
        name: s("Tag name."),
        message: s("Create annotated tag with message."),
        delete: b("Delete the tag."),
        list: b("List tags matching name."),
      }),
      toArgv: (args) => [
        "tag",
        ...(args.delete ? ["--delete"] : []),
        ...(args.list ? ["--list"] : []),
        ...(args.message ? ["-a"] : []),
        ...optionalString(args.name, "name"),
        ...stringFlag("-m", args.message, "message"),
      ],
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
    issueCreate: {
      effect: "external",
      description: "GitHub issue create. Create a GitHub issue.",
      docs: "Create a GitHub issue with title, body, labels, assignees, and optional repo.",
      params: ["title", "body", "label", "assignee", "repo", "github", "issue"],
      inputSchema: obj(
        {
          title: s("Issue title."),
          body: s("Issue body."),
          label: sa("Labels to add."),
          assignee: sa("Assignees to add."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["title"],
      ),
      toArgv: (args) => [
        "issue",
        "create",
        "--title",
        requiredString(args, "title"),
        ...stringFlag("--body", args.body, "body"),
        ...stringArrayFlag("--label", args.label),
        ...stringArrayFlag("--assignee", args.assignee),
        ...repo(args),
      ],
    },
    issueEdit: {
      effect: "external",
      description: "GitHub issue edit. Edit a GitHub issue.",
      docs: "Edit a GitHub issue title, body, labels, assignees, and optional repo.",
      params: [
        "number",
        "title",
        "body",
        "addLabel",
        "removeLabel",
        "addAssignee",
        "removeAssignee",
        "repo",
        "github",
        "issue",
      ],
      inputSchema: obj(
        {
          number: n("Issue number."),
          title: s("Issue title."),
          body: s("Issue body."),
          addLabel: sa("Labels to add."),
          removeLabel: sa("Labels to remove."),
          addAssignee: sa("Assignees to add."),
          removeAssignee: sa("Assignees to remove."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "issue",
        "edit",
        requiredNumber(args, "number"),
        ...stringFlag("--title", args.title, "title"),
        ...stringFlag("--body", args.body, "body"),
        ...stringArrayFlag("--add-label", args.addLabel),
        ...stringArrayFlag("--remove-label", args.removeLabel),
        ...stringArrayFlag("--add-assignee", args.addAssignee),
        ...stringArrayFlag("--remove-assignee", args.removeAssignee),
        ...repo(args),
      ],
    },
    issueComment: {
      effect: "external",
      description: "GitHub issue comment. Add a comment to a GitHub issue.",
      docs: "Add a comment to a GitHub issue with body and optional repo.",
      params: ["number", "body", "repo", "github", "issue", "comment"],
      inputSchema: obj(
        {
          number: n("Issue number."),
          body: s("Comment body."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number", "body"],
      ),
      toArgv: (args) => [
        "issue",
        "comment",
        requiredNumber(args, "number"),
        "--body",
        requiredString(args, "body"),
        ...repo(args),
      ],
    },
    issueClose: {
      effect: "external",
      description: "GitHub issue close. Close a GitHub issue.",
      docs: "Close a GitHub issue with optional repo, comment, and state reason.",
      params: ["number", "repo", "comment", "stateReason", "github", "issue", "close"],
      inputSchema: obj(
        {
          number: n("Issue number."),
          repo: s("Repository in OWNER/REPO format."),
          comment: s("Comment to add while closing the issue."),
          stateReason: issueCloseStateReasonSchema,
        },
        ["number"],
      ),
      toArgv: (args) => [
        "issue",
        "close",
        requiredNumber(args, "number"),
        ...stringFlag("--comment", args.comment, "comment"),
        ...issueCloseStateReason(args.stateReason),
        ...repo(args),
      ],
    },
    issueListBlockedBy: {
      effect: "external",
      description: "GitHub issue blocked_by list. List issues that block an issue.",
      docs: "List first-class GitHub issues that block an issue through the curated dependencies/blocked_by endpoint. Does not expose generic gh api access.",
      params: ["number", "repo", "github", "issue", "dependencies", "blocked_by"],
      inputSchema: obj(
        {
          number: n("Issue number."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "api",
        `${repoApiPath(args.repo)}/issues/${requiredNumber(args, "number")}/dependencies/blocked_by`,
      ],
    },
    issueAddBlockedBy: {
      effect: "external",
      description: "GitHub issue blocked_by add. Add an issue that blocks another issue.",
      docs: "Add a first-class GitHub blocked_by issue dependency through the curated dependencies/blocked_by endpoint. Resolves the blocking issue number within the same repository; no REST database id is accepted from guest code.",
      params: ["number", "blockingNumber", "repo", "github", "issue", "dependencies", "blocked_by"],
      inputSchema: obj(
        {
          number: n("Issue number that is blocked."),
          blockingNumber: n("Issue number that blocks this issue, in the same repository."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number", "blockingNumber"],
      ),
      toArgv: (args) => [
        "api",
        `${repoApiPath(args.repo)}/issues/${requiredNumber(args, "number")}/dependencies/blocked_by`,
        "--method",
        "POST",
        "--field",
        `issue_id={issue-id-for-issue-${requiredNumber(args, "blockingNumber")}}`,
      ],
    },
    issueRemoveBlockedBy: {
      effect: "external",
      description: "GitHub issue blocked_by remove. Remove an issue that blocks another issue.",
      docs: "Remove a first-class GitHub blocked_by issue dependency through the curated dependencies/blocked_by endpoint. Resolves the blocking issue number within the same repository; no REST database id is accepted from guest code.",
      params: ["number", "blockingNumber", "repo", "github", "issue", "dependencies", "blocked_by"],
      inputSchema: obj(
        {
          number: n("Issue number that is blocked."),
          blockingNumber: n("Issue number that blocks this issue, in the same repository."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number", "blockingNumber"],
      ),
      toArgv: (args) => [
        "api",
        `${repoApiPath(args.repo)}/issues/${requiredNumber(args, "number")}/dependencies/blocked_by/{issue-id-for-issue-${requiredNumber(args, "blockingNumber")}}`,
        "--method",
        "DELETE",
      ],
    },
    issueListBlocking: {
      effect: "external",
      description: "GitHub issue blocking list. List issues blocked by an issue.",
      docs: "List first-class GitHub issues that are blocked by an issue through the curated dependencies/blocking endpoint. Does not expose generic gh api access.",
      params: ["number", "repo", "github", "issue", "dependencies", "blocking"],
      inputSchema: obj(
        {
          number: n("Issue number."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "api",
        `${repoApiPath(args.repo)}/issues/${requiredNumber(args, "number")}/dependencies/blocking`,
      ],
    },
    labelCreate: {
      effect: "external",
      description: "GitHub label create. Create a GitHub repository label.",
      docs: "Create a GitHub repository label with name, description, color, and optional repo.",
      params: ["name", "description", "color", "repo", "github", "label"],
      inputSchema: obj(
        {
          name: s("Label name."),
          description: s("Label description."),
          color: s("Label color as a six-character hex code without #."),
          repo: s("Repository in OWNER/REPO format."),
        },
        ["name"],
      ),
      toArgv: (args) => [
        "label",
        "create",
        requiredString(args, "name"),
        ...stringFlag("--description", args.description, "description"),
        ...stringFlag("--color", args.color, "color"),
        ...repo(args),
      ],
    },
    labelList: {
      effect: "external",
      description: "GitHub label list. List GitHub repository labels.",
      docs: "List GitHub repository labels with optional repo and limit.",
      params: ["repo", "limit", "github", "label"],
      inputSchema: obj({
        repo: s("Repository in OWNER/REPO format."),
        limit: n("Maximum number of labels to fetch."),
      }),
      toArgv: (args) => ["label", "list", ...repo(args), ...limit(args)],
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
    prDiff: {
      effect: "external",
      description: "GitHub pull request diff. View changes in a pull request.",
      docs: "View changes in a pull request.",
      params: ["number", "repo", "patch", "github", "pull", "request", "pr", "diff"],
      inputSchema: obj(
        {
          number: n("Pull request number."),
          repo: s("Repository in OWNER/REPO format."),
          patch: b("Display diff in patch format."),
        },
        ["number"],
      ),
      toArgv: (args) => [
        "pr",
        "diff",
        requiredNumber(args, "number"),
        ...repo(args),
        ...(args.patch ? ["--patch"] : []),
      ],
    },
    prChecks: {
      effect: "external",
      description: "GitHub pull request checks. View CI status for a pull request.",
      docs: `View CI status for a pull request. Defaults to JSON output with ${DEFAULT_GH_PR_CHECKS_JSON.join(",")}. Pass json?: string[] to override returned fields.`,
      params: ["number", "repo", "json", "github", "pull", "request", "pr", "checks"],
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
        "checks",
        requiredNumber(args, "number"),
        ...repo(args),
        ...json(args, DEFAULT_GH_PR_CHECKS_JSON),
      ],
    },
    prStatus: {
      effect: "external",
      description: "GitHub pull request status. Show PR status relevant to the current repository.",
      docs: "Show PR status relevant to the current repository. Pass json?: string[] to request JSON fields.",
      params: ["repo", "json", "github", "pull", "request", "pr", "status"],
      inputSchema: obj({
        repo: s("Repository in OWNER/REPO format."),
        json: sa("Fields to return as JSON."),
      }),
      toArgv: (args) => ["pr", "status", ...repo(args), ...json(args)],
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
  vitest: {
    run: {
      effect: "write",
      description: "Vitest run. Run tests once, optionally updating snapshots.",
      docs: "Run Vitest tests once, optionally updating snapshots. Pass reporter: 'json' for machine-readable output.",
      params: ["paths", "update", "reporter"],
      inputSchema: obj({
        paths: sa("Test files or filters to run."),
        update: b("Update snapshots."),
        reporter: vitestReporterSchema,
      }),
      toArgv: (args) => [
        "run",
        ...stringArray(args.paths),
        ...(args.update ? ["--update"] : []),
        ...reporter(args.reporter),
      ],
    },
  },
  tsc: {
    build: {
      effect: "write",
      description: "TypeScript build. Compile the project with tsc.",
      docs: "Compile the project with TypeScript. Pass watch: true for --watch.",
      params: ["watch"],
      inputSchema: obj({ watch: b("Watch input files.") }),
      toArgv: (args) => (args.watch ? ["--watch"] : []),
    },
  },
  oxfmt: {
    check: {
      effect: "write",
      description: "Oxfmt check. Check formatting without writing changes.",
      docs: "Check formatting with oxfmt without writing changes.",
      params: ["paths"],
      inputSchema: obj({ paths: sa("Paths to check.") }),
      toArgv: (args) => [...stringArray(args.paths), "--check"],
    },
    write: {
      effect: "write",
      description: "Oxfmt write. Format files in place.",
      docs: "Format files in place with oxfmt.",
      params: ["paths"],
      inputSchema: obj({ paths: sa("Paths to format.") }),
      toArgv: (args) => [...stringArray(args.paths), "--write"],
    },
  },
  oxlint: {
    run: {
      effect: "write",
      description: "Oxlint run. Run oxlint checks.",
      docs: "Run oxlint checks. Supports deny: 'warnings', vitestPlugin, and paths.",
      params: ["deny", "vitestPlugin", "paths"],
      inputSchema: obj({
        deny: oxlintDenySchema,
        vitestPlugin: b("Enable the vitest plugin."),
        paths: sa("Paths to lint."),
      }),
      toArgv: (args) => [
        ...stringFlag("--deny", args.deny, "deny"),
        ...(args.vitestPlugin ? ["--vitest-plugin"] : []),
        ...stringArray(args.paths),
      ],
    },
  },
  vp: {
    fmtCheck: {
      effect: "write",
      description: "Vite+ fmt check. Check formatting without writing changes.",
      docs: "Check formatting with vp fmt --check. Options are forwarded to Oxfmt.",
      params: ["paths", "ignorePath", "threads"],
      inputSchema: obj({
        paths: sa("Paths to check."),
        ignorePath: s("Path to ignore file."),
        threads: n("Number of threads to use."),
      }),
      toArgv: (args) => [
        "fmt",
        ...stringArray(args.paths),
        "--check",
        ...stringFlag("--ignore-path", args.ignorePath, "ignorePath"),
        ...numberFlag("--threads", args.threads),
      ],
    },
    fmtWrite: {
      effect: "write",
      description: "Vite+ fmt write. Format files in place.",
      docs: "Format files in place with vp fmt --write. Options are forwarded to Oxfmt.",
      params: ["paths", "ignorePath", "threads"],
      inputSchema: obj({
        paths: sa("Paths to format."),
        ignorePath: s("Path to ignore file."),
        threads: n("Number of threads to use."),
      }),
      toArgv: (args) => [
        "fmt",
        ...stringArray(args.paths),
        "--write",
        ...stringFlag("--ignore-path", args.ignorePath, "ignorePath"),
        ...numberFlag("--threads", args.threads),
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
function optionalString(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return [value];
}
function stringFlag(flag: string, value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return [flag, value];
}
function resetMode(value: unknown): string[] {
  if (value === undefined) return [];
  if (["soft", "mixed", "hard"].includes(String(value))) return [`--${String(value)}`];
  throw new Error("mode must be one of soft, mixed, hard");
}
function stashCommand(value: unknown): string[] {
  if (value === undefined) return [];
  if (["push", "pop", "apply", "list", "drop", "clear"].includes(String(value)))
    return [String(value)];
  throw new Error("command must be one of push, pop, apply, list, drop, clear");
}
function pathspec(value: unknown): string[] {
  const paths = stringArray(value);
  return paths.length === 0 ? [] : ["--", ...paths];
}
function repo(args: Record<string, unknown>): string[] {
  if (args.repo === undefined) return [];
  if (typeof args.repo !== "string") throw new Error("repo must be a string");
  return ["--repo", args.repo];
}
function repoApiPath(value: unknown): string {
  if (value === undefined) return "repos/{owner}/{repo}";
  if (typeof value !== "string") throw new Error("repo must be a string");
  if (!/^[^/]+\/[^/]+$/.test(value)) throw new Error("repo must be in OWNER/REPO format");
  return `repos/${value}`;
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
function issueCloseStateReason(value: unknown): string[] {
  if (value === undefined) return [];
  if (["completed", "not planned"].includes(String(value))) return ["--reason", String(value)];
  throw new Error("stateReason must be one of completed, not planned");
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
function reporter(value: unknown): string[] {
  if (value === undefined) return [];
  if (["default", "verbose", "dot", "json", "junit"].includes(String(value))) {
    return [`--reporter=${String(value)}`];
  }
  throw new Error("reporter must be one of default, verbose, dot, json, junit");
}
