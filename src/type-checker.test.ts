import { describe, expect, test } from "vitest";
import { initTypeChecker, typeCheck } from "./type-checker.js";

describe("typeCheck", () => {
  test("accepts valid generated code against provided declarations", () => {
    const result = typeCheck(
      `const text = await codemode.read({ path: "README.md" });\nprint(text.toUpperCase());`,
      `declare const print: (...args: unknown[]) => void;
declare const codemode: {
	read(args: { path: string }): Promise<string>;
};`,
    );

    expect(result.errors).toEqual([]);
  });

  test("reports user-code line and column without counting declaration wrapper lines", () => {
    const result = typeCheck(
      `const ok = 1;
await codemode.read({ path: 123 });`,
      `declare const codemode: {
	read(args: { path: string }): Promise<string>;
};`,
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: 2, col: 23 });
    expect(result.errors[0]?.message).toContain("Type 'number' is not assignable to type 'string'");
  });

  test("adds JSDoc hints for invalid documented object properties", () => {
    const result = typeCheck(
      `await codemode.search({ limit: 2 });`,
      `declare const codemode: {
	search(args: {
		/** Use a duration string such as "1d" or "50". */
		limit: string;
	}): Promise<void>;
};`,
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      'Hint: limit — Use a duration string such as "1d" or "50".',
    );
  });

  test("initTypeChecker is idempotent", () => {
    initTypeChecker();
    initTypeChecker();

    expect(typeCheck("const value: Promise<number> = Promise.resolve(1);", "").errors).toEqual([]);
  });
});
