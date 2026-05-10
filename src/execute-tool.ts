// execute-tool.ts — The execute_tools tool definition.
//
// This is the single tool that replaces most of Pi's built-in tools.
// The LLM writes TypeScript code that calls tools as typed functions.

import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
- replace_in_file({ path, edits: [{ oldText, newText }] }) → exact text replacement in a file
- apply_patch({ patch }) → apply a unified diff inside the project root
- codemode.search_tools({ query }) → discover available tools
- codemode.describe_tools({ namespace, tool? }) → browse MCP tools
- codemode.<namespace>.<tool>(args) → call MCP tools (e.g., codemode.github.search_issues())
- codemode.progress(msg) → stream progress to UI
- print(...) → optional diagnostic/progress output; avoid printing values you also return
- π.keyName → string constants from the 'strings' parameter

Return the final value you want in the result. Prefer return over print for final output; Type errors are returned for correction.`,

    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript code body. Has access to read(), write(), replace_in_file(), apply_patch(), codemode.search_tools(), codemode.describe_tools(), codemode.<namespace>.<tool>() for MCP, print(), and π.keyName from strings parameter.",
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
      theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
      _context: unknown,
    ) {
      let text = theme.fg("toolTitle", theme.bold("execute_tools"));
      const code = args.code?.trim() || "(empty code)";
      const lines = code.split("\n");
      text += theme.fg("dim", `  ${lines.length} line${lines.length === 1 ? "" : "s"}`);

      if (args.strings && Object.keys(args.strings).length > 0) {
        text += theme.fg("dim", `, ${Object.keys(args.strings).length} string constant(s)`);
      }

      text += "\n" + code;

      if (args.strings && Object.keys(args.strings).length > 0) {
        text += "\n" + theme.fg("dim", "\nString constants:");
        for (const [key, value] of Object.entries(args.strings)) {
          const preview = value.length > 120 ? value.slice(0, 120) + "..." : value;
          text += "\n" + theme.fg("dim", `π.${key} = ${JSON.stringify(preview)}`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
        details?: {
          elapsedMs?: number;
          errors?: TypeCheckError[];
          logs?: string[];
          progress?: unknown;
        };
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: {
        fg: (color: string, text: string) => string;
        error: (text: string) => string;
        success: (text: string) => string;
        warning: (text: string) => string;
      },
      _context: unknown,
    ) {
      if (options.isPartial) {
        const msg = result.details?.progress
          ? (result.content?.[0]?.text ?? "Executing...")
          : "Executing...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const elapsed = result.details?.elapsedMs
        ? ` ${theme.fg("dim", `(${Math.round(result.details.elapsedMs)}ms)`)}`
        : "";

      if (result.isError) {
        const errors = result.details?.errors ?? [];
        const first = errors[0];
        if (!options.expanded) {
          return new Text(theme.error(`✗ ${first?.message ?? "Error"}`) + elapsed, 0, 0);
        }
        const errorText =
          errors.length > 0
            ? errors
                .map((error) => `${error.line > 0 ? `Line ${error.line}: ` : ""}${error.message}`)
                .join("\n")
            : (result.content?.[0]?.text ?? "Error");
        return new Text(theme.error(errorText) + elapsed, 0, 0);
      }

      const content = (result.content?.[0]?.text ?? "(no output)").trim();
      const lines = content.split("\n");
      if (!options.expanded && lines.length > 6) {
        const preview = lines.slice(0, 4).join("\n");
        return new Text(
          theme.success("✓ ") +
            preview +
            theme.fg("dim", `\n... ${lines.length - 4} more lines`) +
            elapsed,
          0,
          0,
        );
      }

      return new Text(theme.success("✓ ") + content + elapsed, 0, 0);
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
