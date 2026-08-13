// resolve-host-fn.ts — Shared host-function path resolution for executors.
//
// Resolves a dot-separated tool name (e.g. "mcp.github.search_issues") against
// the host-provided execution providers. This is the trust boundary between
// sandboxed guest code and host functions, so it MUST NOT walk the prototype
// chain: names such as "constructor", "prototype", "__proto__", "toString",
// or "valueOf" must never resolve to a host function.
//
// Dynamic Proxy-backed namespaces (uncached MCP tools) are preserved: a Proxy's
// [[Get]] trap is allowed to run so lazy tool names still resolve, but the
// prototype-chain denylist is applied before any access.

import type { ExecutionProvider } from "./types.js";

type HostFn = (args: unknown) => unknown | Promise<unknown>;

// Every member of Object.prototype (and Function.prototype) that a guest could
// reach by walking the prototype chain. Blocking these names prevents the guest
// from invoking host constructors/methods that were never registered as tools.
const PROTOTYPE_NAMES = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

// A unique symbol used to detect Proxy-backed objects. A Proxy's [[Get]] trap
// intercepts symbol access too, so a proxy-like object returns a non-undefined
// value for this probe while a plain object returns undefined.
const PROXY_PROBE = Symbol("codemode.proxy.probe");

function isProxyLike(obj: unknown): boolean {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return false;
  try {
    return (obj as Record<symbol, unknown>)[PROXY_PROBE] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Safely read a single path segment from an object.
 *
 * - Prototype-chain names are always rejected.
 * - Proxy-backed objects are accessed through their [[Get]] trap so dynamic
 *   (uncached) MCP namespaces still resolve.
 * - Plain objects only expose their own properties, never inherited ones.
 */
function safeGet(obj: unknown, key: string): unknown {
  if (PROTOTYPE_NAMES.has(key)) return undefined;
  if (isProxyLike(obj)) return (obj as Record<string, unknown>)[key];
  return Object.prototype.hasOwnProperty.call(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function resolvePath(root: unknown, path: string): HostFn | undefined {
  let current = root;
  for (const part of path.split(".")) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      return undefined;
    }
    current = safeGet(current, part);
  }
  return typeof current === "function" ? (current as HostFn) : undefined;
}

/**
 * Build a resolver for a set of execution providers.
 *
 * Accepts either an array of named providers or a single record (treated as the
 * "codemode" provider). Top-level helpers such as `read` and `sendMessage` are
 * backed by the codemode provider, so names that are not found under a named
 * namespace fall back to the codemode root.
 */
export function createHostFnResolver(
  providersOrFns: ExecutionProvider[] | Record<string, unknown>,
): (name: string) => HostFn | undefined {
  const roots = Array.isArray(providersOrFns)
    ? Object.fromEntries(providersOrFns.map((provider) => [provider.name, provider.fns]))
    : { codemode: providersOrFns };
  const codemodeRoot = roots.codemode;

  return (name: string): HostFn | undefined => {
    const namespaced = resolvePath(roots, name);
    if (namespaced) return namespaced;
    return resolvePath(codemodeRoot, name);
  };
}
