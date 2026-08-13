import { describe, expect, test } from "vitest";
import { createHostFnResolver } from "./resolve-host-fn.js";

describe("createHostFnResolver", () => {
  test("resolves a top-level provider function", () => {
    const resolve = createHostFnResolver([{ name: "codemode", fns: { read: () => "x" } }]);
    expect(resolve("read")).toBeTypeOf("function");
  });

  test("resolves a nested namespaced function", () => {
    const resolve = createHostFnResolver([
      { name: "mcp", fns: { github: { search_issues: () => "ok" } } },
    ]);
    expect(resolve("mcp.github.search_issues")).toBeTypeOf("function");
  });

  test("resolves a legacy codemode MCP namespace", () => {
    const resolve = createHostFnResolver([
      { name: "codemode", fns: { github: { search_issues: () => "ok" } } },
    ]);
    expect(resolve("codemode.github.search_issues")).toBeTypeOf("function");
  });

  test("returns undefined for an unknown tool", () => {
    const resolve = createHostFnResolver([{ name: "codemode", fns: { read: () => "x" } }]);
    expect(resolve("nope")).toBeUndefined();
    expect(resolve("mcp.github.nope")).toBeUndefined();
  });

  test("does not resolve prototype-chain names", () => {
    const resolve = createHostFnResolver([{ name: "codemode", fns: { read: () => "x" } }]);
    for (const name of [
      "constructor",
      "constructor.constructor",
      "prototype",
      "__proto__",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__defineGetter__",
      "__defineSetter__",
      "__lookupGetter__",
      "__lookupSetter__",
    ]) {
      expect(resolve(name)).toBeUndefined();
    }
  });

  test("does not resolve prototype-chain names nested under a namespace", () => {
    const resolve = createHostFnResolver([
      { name: "codemode", fns: { github: { search_issues: () => "ok" } } },
    ]);
    for (const name of [
      "codemode.constructor",
      "codemode.github.constructor",
      "codemode.github.__proto__",
      "codemode.github.toString",
      "codemode.constructor.constructor",
    ]) {
      expect(resolve(name)).toBeUndefined();
    }
  });

  test("does not resolve inherited properties on plain objects", () => {
    const proto = { evil: () => "pwned" };
    const fns = Object.create(proto);
    fns.read = () => "x";
    const resolve = createHostFnResolver([{ name: "codemode", fns }]);
    expect(resolve("read")).toBeTypeOf("function");
    expect(resolve("evil")).toBeUndefined();
  });

  test("preserves dynamic Proxy-backed uncached MCP calls", () => {
    const dynamicNamespace = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "then") return undefined;
          return async (args: unknown) => ({ tool: prop, args });
        },
      },
    );
    const resolve = createHostFnResolver([
      { name: "codemode", fns: { context7: dynamicNamespace } },
    ]);
    const fn = resolve("codemode.context7.resolve_library_id");
    expect(fn).toBeTypeOf("function");
  });

  test("preserves dynamic Proxy-backed calls that mix cached and uncached tools", () => {
    const cached: Record<string, unknown> = { cached_tool: () => "cached" };
    const dynamicNamespace = new Proxy(cached, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return async (args: unknown) => ({ tool: prop, args });
      },
    });
    const resolve = createHostFnResolver([{ name: "codemode", fns: { ns: dynamicNamespace } }]);
    expect(resolve("codemode.ns.cached_tool")).toBeTypeOf("function");
    expect(resolve("codemode.ns.uncached_tool")).toBeTypeOf("function");
  });

  test("preserves the tool-bindings.ts MCP Proxy shape (cached + uncached)", () => {
    // Mirrors src/tool-bindings.ts: a plain serverProxy target with a get trap
    // that returns the cached tool or a lazy function for uncached tools.
    const serverProxy: Record<string, unknown> = {
      search_issues: () => "cached",
    };
    const proxy = new Proxy(serverProxy, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return async (args: unknown) => ({ tool: prop, args });
      },
    });
    const resolve = createHostFnResolver([{ name: "mcp", fns: { github: proxy } }]);
    expect(resolve("mcp.github.search_issues")).toBeTypeOf("function");
    expect(resolve("mcp.github.uncached_tool")).toBeTypeOf("function");
  });

  test("blocks prototype-chain names even through a Proxy get trap", () => {
    const dynamicNamespace = new Proxy(
      {},
      {
        get(_target, prop: string) {
          // A naive proxy would happily return a function for "constructor".
          return async (args: unknown) => ({ tool: prop, args });
        },
      },
    );
    const resolve = createHostFnResolver([{ name: "codemode", fns: { ns: dynamicNamespace } }]);
    expect(resolve("codemode.ns.constructor")).toBeUndefined();
    expect(resolve("codemode.ns.__proto__")).toBeUndefined();
    expect(resolve("codemode.ns.toString")).toBeUndefined();
  });
});
