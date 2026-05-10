// execute-tool.ts — The execute_tools tool definition.
//
// This is the single tool that replaces most of Pi's built-in tools.
// The LLM writes TypeScript code that calls tools as typed functions.

import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { typeCheck, type TypeCheckError } from "./type-checker.js";
import type { ToolBindings } from "./tool-bindings.js";
import { createExecutor, type ExecutorFactoryOptions } from "./executor/index.js";

export interface ExecutionResult {
  success: boolean;
  /** Type errors or runtime errors */
  errors: TypeCheckError[];
  /** 'type' for type-check failures, 'runtime' for execution errors */
  errorKind?: "type" | "runtime";
  /** Captured console.log / print output */
  logs: string[];
  /** The return value of the code (if any) */
  returnValue: unknown;
  /** Execution time in ms */
  elapsedMs: number;
}

export interface ExecuteToolOptions {
  /** TypeScript type definitions for the tool API */
  typeDefs: string;
  /** Tool bindings for execution */
  bindings: ToolBindings;
  /** Max execution time in ms (default: 120_000 = 2 minutes) */
  timeout?: number;
  /** Max output size in bytes (default: 50KB) */
  maxOutputSize?: number;
  /** Sandbox executor selection. Defaults to QuickJS. */
  executor?: ExecutorFactoryOptions;
}

/**
 * Create the execute_tools tool definition.
 */
export function createExecuteTool(options: ExecuteToolOptions): ToolDefinition {
  const { typeDefs, bindings, timeout, maxOutputSize, executor } = options;

  return {
    name: "execute_tools",
    label: "Execute Tools",
    description: `Execute TypeScript code that calls tools as typed functions.
Write code using top-level file tools and the codemode.* API. Your code is type-checked before execution.

Available tools in code:
- read({ path }) → file content as string
- write({ path, content }) → void
- edit({ path, edits: [{ oldText, newText }] }) → exact text replacement in a file
- codemode.search_tools({ query }) → discover available tools
- codemode.describe_tools({ namespace, tool? }) → browse MCP tools
- codemode.<namespace>.<tool>(args) → call MCP tools (e.g., codemode.github.search_issues())
- codemode.progress(msg) → stream progress to UI
- print(...) → output to include in result
- π.keyName → string constants from the 'strings' parameter

Return a value to include it in the result. Type errors are returned for correction.`,

    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript code body. Has access to read(), write(), edit(), codemode.search_tools(), codemode.describe_tools(), codemode.<namespace>.<tool>() for MCP, print(), and π.keyName from strings parameter.",
      }),
      strings: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Named string constants injected into the code as π.keyName. Use this for file content, templates, or any text that would be hard to quote inside JavaScript code. The strings only need standard JSON escaping — no JS string literal escaping required.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { code: string; strings?: Record<string, string> },
      signal: AbortSignal | undefined,
      onUpdate: (update: {
        content: Array<{ type: string; text: string }>;
        details?: unknown;
      }) => void,
      _ctx: ExtensionContext,
    ) {
      // For now, do a type check only (Phase 2)
      // Phase 3 will add actual execution
      const result = await executeCode(params.code, typeDefs, bindings, {
        timeout,
        maxOutputSize,
        signal,
        onUpdate,
        strings: params.strings,
        executor,
      });

      if (!result.success) {
        const errorText = result.errors
          .map((e) => (e.line > 0 ? `Line ${e.line}: ${e.message}` : e.message))
          .join("\n");

        let text: string;
        if (result.errorKind === "type") {
          text = `Type errors (code was NOT executed):\n${errorText}\n\nFix the type errors and try again.`;
        } else {
          text = `Runtime error:\n${errorText}\n\nThe code executed but threw an error. This may be a bug in your code or a server-side issue.`;
        }

        // Include any logs captured before the error (for runtime errors)
        if (result.logs.length > 0) {
          text = `Output before error:\n${result.logs.join("\n")}\n\n${text}`;
        }

        return {
          content: [{ type: "text" as const, text }],
          isError: true,
          details: {
            errors: result.errors,
            logs: result.logs,
            elapsedMs: result.elapsedMs,
          },
        };
      }

      // Format success
      const parts: string[] = [];

      if (result.logs.length > 0) {
        parts.push(result.logs.join("\n"));
      }

      if (result.returnValue !== undefined) {
        const formatted =
          typeof result.returnValue === "string"
            ? result.returnValue
            : JSON.stringify(result.returnValue, null, 2);
        parts.push(formatted);
      }

      const text = parts.join("\n\n") || "(no output)";

      return {
        content: [{ type: "text" as const, text }],
        details: {
          logs: result.logs,
          returnValue: result.returnValue,
          elapsedMs: result.elapsedMs,
        },
      };
    },

    renderCall(
      args: { code: string; strings?: Record<string, string> },
      theme: { fg: (color: string, text: string) => string },
    ) {
      try {
        // Simple text rendering without Pi TUI dependencies
        let text = args.code.trim();

        // Show string constants if present
        if (args.strings && Object.keys(args.strings).length > 0) {
          const stringsSection = Object.entries(args.strings)
            .map(([key, val]) => {
              const preview = val.length > 200 ? val.slice(0, 200) + "..." : val;
              return theme.fg("dim", `π.${key}`) + " = " + theme.fg("dim", JSON.stringify(preview));
            })
            .join("\n");
          text = theme.fg("dim", "// String constants:") + "\n" + stringsSection + "\n\n" + text;
        }

        // Return plain text - Pi will handle rendering
        return text;
      } catch {
        return String(args.code ?? "");
      }
    },

    renderResult(
      result: any,
      options: { expanded: boolean; isPartial: boolean },
      theme: {
        fg: (color: string, text: string) => string;
        error: (text: string) => string;
        success: (text: string) => string;
        warning: (text: string) => string;
      },
    ) {
      const { isPartial, expanded } = options;

      if (isPartial) {
        const msg = result.details?.progress
          ? (result.content?.[0]?.text ?? "Executing...")
          : "Executing...";
        return theme.fg("warning", msg);
      }

      const details = result.details ?? {};
      const isError = result.isError;
      const elapsed = details.elapsedMs
        ? ` ${theme.fg("dim", `(${Math.round(details.elapsedMs)}ms)`)}`
        : "";

      if (isError) {
        const errors = details.errors ?? [];
        const firstError = errors[0]?.message ?? "Unknown error";
        if (!expanded) {
          return theme.fg("error", `✗ ${firstError}`) + elapsed;
        }
        const lines = errors
          .map((e: any) => theme.fg("error", e.line > 0 ? `Line ${e.line}: ` : "") + e.message)
          .join("\n");
        return lines + elapsed;
      }

      // Success — trim to avoid leading/trailing blank lines
      const text = (result.content?.[0]?.text ?? "(no output)").trim();
      const lineCount = text.split("\n").length;

      if (!expanded && lineCount > 5) {
        const preview = text.split("\n").slice(0, 3).join("\n");
        return (
          theme.fg("success", "✓ ") +
          preview +
          theme.fg("dim", `\n... ${lineCount - 3} more lines`) +
          elapsed
        );
      }

      return theme.fg("success", "✓ ") + text + elapsed;
    },
  } as unknown as ToolDefinition;
}

/**
 * Execute TypeScript code with type checking and configured sandbox execution.
 */
async function executeCode(
  code: string,
  typeDefs: string,
  bindings: ToolBindings,
  options?: {
    timeout?: number;
    maxOutputSize?: number;
    signal?: AbortSignal;
    onUpdate?: (update: {
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }) => void;
    strings?: Record<string, string>;
    executor?: ExecutorFactoryOptions;
  },
): Promise<ExecutionResult> {
  const start = performance.now();

  // Step 1: Type-check
  const checkResult = typeCheck(code, typeDefs);
  if (checkResult.errors.length > 0) {
    return {
      success: false,
      errorKind: "type",
      errors: checkResult.errors,
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }

  // Simulate execution progress
  if (options?.onUpdate) {
    options.onUpdate({
      content: [{ type: "text", text: "Code type-checked successfully, executing..." }],
      details: { progress: true },
    });
  }

  // Step 2: Execute in the configured sandbox. QuickJS is the MVP default.
  try {
    const executorOptions: ExecutorFactoryOptions = {
      ...options?.executor,
      timeout: options?.timeout ?? options?.executor?.timeout,
    };
    const executor = createExecutor(executorOptions);

    // Convert bindings to the provider format expected by the executor
    const providers = [
      {
        name: "codemode",
        fns: bindings as Record<string, (...args: unknown[]) => Promise<unknown>>,
      },
    ];

    const result = await executor.execute(code, providers, {
      strings: options?.strings,
      signal: options?.signal,
    });

    return {
      success: !result.error,
      errorKind: result.error ? "runtime" : undefined,
      errors: result.error ? [{ line: 0, col: 0, message: result.error }] : [],
      logs: result.logs ?? [],
      returnValue: result.result,
      elapsedMs: performance.now() - start,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const configuredKind = options?.executor?.kind ?? "quickjs";
    const message =
      rawMessage.includes("ENOENT") || rawMessage.includes("spawn")
        ? `Configured executor '${configuredKind}' is unavailable: ${rawMessage}`
        : rawMessage;
    return {
      success: false,
      errorKind: "runtime",
      errors: [{ line: 0, col: 0, message }],
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }
}
