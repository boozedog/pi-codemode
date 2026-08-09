import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  initTypeChecker,
  resetTypeCheckerForTests,
  resolveTypeScriptLibDir,
  typeCheck,
} from "./type-checker.js";

describe("typeCheck", () => {
  afterEach(() => {
    resetTypeCheckerForTests();
  });

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

  test("resolves typescript lib files via createRequire (works when package is hoisted)", () => {
    const libDir = resolveTypeScriptLibDir();

    expect(existsSync(join(libDir, "lib.es2022.d.ts"))).toBe(true);
    expect(existsSync(join(libDir, "lib.es2015.promise.d.ts"))).toBe(true);
    expect(existsSync(join(libDir, "lib.es5.d.ts"))).toBe(true);
  });

  test("initTypeChecker fails loudly when no lib files can be loaded", () => {
    expect(() => initTypeChecker({ libDir: "/nonexistent/typescript/lib" })).toThrow(
      /no TS lib files under \/nonexistent\/typescript\/lib/,
    );
  });

  test("type-checks Promise and Record globals after init", () => {
    initTypeChecker();
    const result = typeCheck(
      `const value: Promise<number> = Promise.resolve(1);
const map: Record<string, number> = { a: 1 };
const ro: Readonly<{ x: number }> = { x: 2 };
return await value;`,
      "",
    );
    expect(result.errors).toEqual([]);
  });
});
