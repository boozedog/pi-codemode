import { describe, expect, test } from "vitest";
import { buildSearchIndex, searchTools } from "./search.js";

describe("tool search", () => {
  test("reports unavailable and empty search states", () => {
    buildSearchIndex([]);

    expect(searchTools("read")).toBe("Search index not built yet. No tools available.");

    buildSearchIndex([{ name: "read", description: "Read file contents" }]);

    expect(searchTools("   ")).toBe("Empty search query.");
  });

  test("indexes only generated-code Pi tools and truncates long descriptions", () => {
    buildSearchIndex([
      { name: "execute_tools", description: "internal executor" },
      { name: "bash", description: "Execute unrestricted bash" },
      { name: "ls", description: "Native harness ls" },
      { name: "read", description: "x".repeat(250) },
    ]);

    const output = searchTools("read bash ls");

    expect(output).toContain("[pi] codemode.read()");
    expect(output).toContain(`${"x".repeat(200)}...`);
    expect(output).not.toContain("execute_tools");
    expect(output).not.toContain("codemode.bash()");
    expect(output).not.toContain("codemode.ls()");
  });

  test("indexes configured CLI operations", () => {
    buildSearchIndex([], [], {
      git: { backend: "host", operations: ["status", "branch"] },
      gh: { backend: "host", operations: ["issueView"] },
    });

    const gitOutput = searchTools("git");
    expect(gitOutput).toContain("[cli] cli.git.status()");
    expect(gitOutput).toContain("[cli] cli.git.branch()");

    const ghOutput = searchTools("github issue");
    expect(ghOutput).toContain("[cli] cli.gh.issueView()");
  });

  test("indexes MCP namespace, description, and input parameter names", () => {
    buildSearchIndex(
      [],
      [
        {
          serverName: "GitHub",
          namespace: "github",
          tools: [
            {
              name: "search_issues",
              description: "Find matching issues",
              inputSchema: {
                type: "object",
                properties: { owner: { type: "string" }, repo: { type: "string" } },
              },
            },
          ],
        },
      ],
    );

    expect(searchTools("owner")).toContain("[github] codemode.github.search_issues()");
    expect(searchTools("repo")).toContain("Find matching issues");
  });

  test("does not use fuzzy matching for short queries", () => {
    buildSearchIndex(
      [
        {
          name: "write",
          description:
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
        },
        {
          name: "bash",
          description: "Output is truncated to 50KB, whichever is hit first.",
        },
      ],
      [],
      { git: { backend: "host", operations: ["status"] } },
    );

    const output = searchTools("git");

    expect(output).toContain("cli.git.status()");
    expect(output).not.toContain("codemode.write()");
    expect(output).not.toContain("codemode.bash()");
  });

  test("keeps fuzzy matching for longer queries", () => {
    buildSearchIndex(
      [],
      [
        {
          serverName: "GitHub",
          namespace: "github",
          tools: [{ name: "search_issues", description: "Find matching GitHub issues" }],
        },
      ],
    );

    expect(searchTools("githb")).toContain("codemode.github.search_issues()");
  });

  test("limits result count and reports omitted matches", () => {
    buildSearchIndex(
      [],
      [
        {
          serverName: "Files",
          namespace: "files",
          tools: [
            { name: "read_file", description: "read" },
            { name: "read_many", description: "read" },
          ],
        },
      ],
    );

    const output = searchTools("read", 1);

    expect(output).toContain('Found 2 tools matching "read" (showing top 1):');
    expect(output.match(/\[files\]/g)).toHaveLength(1);
  });
});
