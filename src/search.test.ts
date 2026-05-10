import { describe, expect, test } from "vitest";
import { buildSearchIndex, searchTools } from "./search.js";

describe("tool search", () => {
  test("reports unavailable and empty search states", () => {
    buildSearchIndex([]);

    expect(searchTools("read")).toBe("Search index not built yet. No tools available.");

    buildSearchIndex([{ name: "read", description: "Read file contents" }]);

    expect(searchTools("   ")).toBe("Empty search query.");
  });

  test("indexes Pi tools, skips execute_tools, and truncates long descriptions", () => {
    buildSearchIndex([
      { name: "execute_tools", description: "internal executor" },
      { name: "read", description: "x".repeat(250) },
    ]);

    const output = searchTools("read");

    expect(output).toContain('Found 1 tool matching "read"');
    expect(output).toContain("[pi] codemode.read()");
    expect(output).toContain(`${"x".repeat(200)}...`);
    expect(output).not.toContain("execute_tools");
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

  test("limits result count and reports omitted matches", () => {
    buildSearchIndex([
      { name: "read_file", description: "read" },
      { name: "read_many", description: "read" },
    ]);

    const output = searchTools("read", 1);

    expect(output).toContain('Found 2 tools matching "read" (showing top 1):');
    expect(output.match(/\[pi\]/g)).toHaveLength(1);
  });
});
