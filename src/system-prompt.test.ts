import { describe, expect, test } from "vitest";
import {
  generateEditGuidance,
  generateNativeEditGuidance,
  generateSystemPromptAddition,
} from "./system-prompt.js";

describe("system prompt builders", () => {
  test("on mode omits native bash and includes type defs", () => {
    const prompt = generateSystemPromptAddition("declare const codemode: {};", "", "on");
    expect(prompt).toContain("## Code Mode (on)");
    expect(prompt).toContain("native bash tool is not exposed");
    expect(prompt).toContain("declare const codemode: {};");
    expect(prompt).toContain("top-level visible patch editing");
    expect(prompt).not.toMatch(/#\d+/);
  });

  test("yolo mode mentions native bash escape hatch", () => {
    const prompt = generateSystemPromptAddition("declare const x: 1;", "", "yolo");
    expect(prompt).toContain("## Code Mode (yolo)");
    expect(prompt).toContain("native bash is available");
  });

  test("includes MCP summary when provided", () => {
    const prompt = generateSystemPromptAddition(
      "declare const codemode: {};",
      "### MCP\n- github",
      "on",
    );
    expect(prompt).toContain("### MCP");
    expect(prompt).toContain("- github");
  });

  test("native off-mode guidance is edit-only", () => {
    const prompt = generateNativeEditGuidance();
    expect(prompt).toContain("## Native Tool Guidance");
    expect(prompt).toContain(generateEditGuidance());
    expect(prompt).not.toMatch(/#\d+/);
  });
});
