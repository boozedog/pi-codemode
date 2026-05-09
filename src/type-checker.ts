// type-checker.ts — Full TypeScript type-checking of LLM-generated code against tool API declarations.
//
// Uses ts.createProgram with a virtual file system containing:
// - ES2022 lib .d.ts files (pre-parsed once at init)
// - Tool type definitions (updated when tools are discovered)
// - The user's code wrapped in an async IIFE
//
// Module resolution: Node10 with a virtual file system.
// Performance: ~5ms per check after warmup. Lib loading: ~150ms once.

import ts from "typescript";
import fsReal from "node:fs";
import pathReal from "node:path";
import { fileURLToPath } from "node:url";

export interface TypeCheckError {
	/** Line number in user's code (1-indexed) */
	line: number;
	/** Column number (1-indexed) */
	col: number;
	/** TypeScript error message */
	message: string;
}

export interface TypeCheckResult {
	errors: TypeCheckError[];
}

// Pre-parsed SourceFile objects, keyed by virtual path (without leading /)
let sourceFiles: Map<string, ts.SourceFile> | null = null;
// Raw file content, keyed by virtual path (without leading /)
let fileContent: Map<string, string> | null = null;
// Directories that exist in the virtual FS (for directoryExists)
let directories: Set<string> | null = null;

const LIB_NAMES = [
	"lib.es5.d.ts",
	"lib.es2015.d.ts",
	"lib.es2015.promise.d.ts",
	"lib.es2015.iterable.d.ts",
	"lib.es2015.collection.d.ts",
	"lib.es2015.symbol.d.ts",
	"lib.es2015.symbol.wellknown.d.ts",
	"lib.es2015.core.d.ts",
	"lib.es2015.generator.d.ts",
	"lib.es2015.proxy.d.ts",
	"lib.es2015.reflect.d.ts",
	"lib.es2016.d.ts",
	"lib.es2016.array.include.d.ts",
	"lib.es2017.d.ts",
	"lib.es2017.string.d.ts",
	"lib.es2017.object.d.ts",
	"lib.es2017.sharedmemory.d.ts",
	"lib.es2017.intl.d.ts",
	"lib.es2017.typedarrays.d.ts",
	"lib.es2018.d.ts",
	"lib.es2018.asyncgenerator.d.ts",
	"lib.es2018.asynciterable.d.ts",
	"lib.es2018.intl.d.ts",
	"lib.es2018.promise.d.ts",
	"lib.es2018.regexp.d.ts",
	"lib.es2019.d.ts",
	"lib.es2019.array.d.ts",
	"lib.es2019.object.d.ts",
	"lib.es2019.string.d.ts",
	"lib.es2019.symbol.d.ts",
	"lib.es2019.intl.d.ts",
	"lib.es2020.d.ts",
	"lib.es2020.string.d.ts",
	"lib.es2020.symbol.wellknown.d.ts",
	"lib.es2020.bigint.d.ts",
	"lib.es2020.promise.d.ts",
	"lib.es2020.sharedmemory.d.ts",
	"lib.es2020.intl.d.ts",
	"lib.es2020.date.d.ts",
	"lib.es2020.number.d.ts",
	"lib.es2021.d.ts",
	"lib.es2021.promise.d.ts",
	"lib.es2021.string.d.ts",
	"lib.es2021.weakref.d.ts",
	"lib.es2021.intl.d.ts",
	"lib.es2022.d.ts",
	"lib.es2022.array.d.ts",
	"lib.es2022.error.d.ts",
	"lib.es2022.object.d.ts",
	"lib.es2022.string.d.ts",
	"lib.es2022.regexp.d.ts",
	"lib.es2022.intl.d.ts",
];

/**
 * Initialize the type checker by pre-parsing TS lib files.
 * Call once at extension load. Subsequent calls are no-ops.
 */
export function initTypeChecker(): void {
	if (sourceFiles) return;

	sourceFiles = new Map();
	fileContent = new Map();
	directories = new Set();

	// Load ES2022 lib files from TypeScript's lib directory
	// In ESM, we need to resolve typescript differently
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = pathReal.dirname(__filename);

	// Resolve typescript lib path by finding the package
	let tsLibDir: string;
	try {
		// Try to resolve from the typescript package
		const tsPath = pathReal.resolve(__dirname, "../node_modules/typescript/lib/lib.es2022.d.ts");
		if (fsReal.existsSync(tsPath)) {
			tsLibDir = pathReal.dirname(tsPath);
		} else {
			// Fallback: try global resolution
			tsLibDir = pathReal.dirname(require.resolve("typescript/lib/lib.es2022.d.ts"));
		}
	} catch {
		// Last resort: assume standard node_modules structure
		tsLibDir = pathReal.resolve(__dirname, "../node_modules/typescript/lib");
	}

	for (const name of LIB_NAMES) {
		const filePath = pathReal.join(tsLibDir, name);
		if (fsReal.existsSync(filePath)) {
			addFile(name, fsReal.readFileSync(filePath, "utf-8"));
		}
	}
}

/** Add a file to the virtual file system. */
function addFile(virtualPath: string, content: string): void {
	fileContent!.set(virtualPath, content);
	sourceFiles!.set(
		virtualPath,
		ts.createSourceFile(virtualPath, content, ts.ScriptTarget.ESNext, true)
	);
	// Register all parent directories
	let dir = virtualPath;
	while (true) {
		const parent = dir.includes("/") ? dir.substring(0, dir.lastIndexOf("/")) : "";
		if (parent === dir) break;
		dir = parent;
		if (dir) directories!.add(dir);
	}
}

/**
 * Normalize a path from the compiler — strip leading "/" to match our virtual paths.
 * getCurrentDirectory() returns "/", so TS prepends it to relative paths.
 */
function normalizePath(p: string): string {
	return p.startsWith("/") ? p.slice(1) : p;
}

/**
 * Type-check user code against the provided type definitions.
 *
 * @param userCode - The code body written by the LLM (no function wrapper needed)
 * @param typeDefs - TypeScript declaration string for the tool API
 * @returns TypeCheckResult with any errors found
 */
export function typeCheck(
	userCode: string,
	typeDefs: string
): TypeCheckResult {
	if (!sourceFiles) {
		initTypeChecker();
	}

	const typeDefLineCount = typeDefs.split("\n").length;
	// +1 for the "(async () => {" wrapper line
	const prefixLineCount = typeDefLineCount + 1;

	const fullSource =
		typeDefs + "\n(async () => {\n" + userCode + "\n})();\n";
	const fileName = "codemode.ts";
	const sourceFile = ts.createSourceFile(
		fileName,
		fullSource,
		ts.ScriptTarget.ESNext,
		true
	);

	const host: ts.CompilerHost = {
		getSourceFile: (name: string) => {
			if (name === fileName) return sourceFile;
			const normalized = normalizePath(name);
			return sourceFiles!.get(name) ?? sourceFiles!.get(normalized);
		},
		getDefaultLibFileName: () => "lib.es5.d.ts",
		writeFile: () => {},
		getCurrentDirectory: () => "/",
		getCanonicalFileName: (f: string) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (f: string) => {
			if (f === fileName) return true;
			const normalized = normalizePath(f);
			return fileContent!.has(f) || fileContent!.has(normalized);
		},
		readFile: (f: string) => {
			const normalized = normalizePath(f);
			return fileContent!.get(f) ?? fileContent!.get(normalized);
		},
		directoryExists: (dir: string) => {
			const normalized = normalizePath(dir);
			return directories!.has(dir) || directories!.has(normalized);
		},
		getDirectories: (dir: string) => {
			const normalized = normalizePath(dir);
			const prefix = normalized ? normalized + "/" : "";
			const subdirs = new Set<string>();
			for (const d of directories!) {
				if (d.startsWith(prefix) && d !== normalized) {
					const rest = d.slice(prefix.length);
					const firstSegment = rest.split("/")[0];
					if (firstSegment) subdirs.add(firstSegment);
				}
			}
			return [...subdirs];
		},
		// Needed so TS resolves parent of getCurrentDirectory
		realpath: (f: string) => f,
	};

	const program = ts.createProgram(
		[fileName, ...sourceFiles!.keys()],
		{
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Node10,
			strict: true,
			noEmit: true,
			skipLibCheck: true,
		},
		host
	);

	const checker = program.getTypeChecker();

	// Only get diagnostics for our file, not lib files
	const syntaxDiags = program.getSyntacticDiagnostics(sourceFile);
	const semanticDiags = program.getSemanticDiagnostics(sourceFile);
	const allDiags = [...syntaxDiags, ...semanticDiags];

	const errors: TypeCheckError[] = allDiags.map((d) => {
		let msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
		if (d.file && d.start !== undefined) {
			// Try to enrich type errors with parameter documentation
			msg = enrichErrorMessage(msg, d, sourceFile, checker);

			const pos = d.file.getLineAndCharacterOfPosition(d.start);
			// Adjust line number: subtract type def prefix and IIFE wrapper
			const userLine = pos.line - prefixLineCount;
			return {
				line: Math.max(1, userLine + 1),
				col: pos.character + 1,
				message: msg,
			};
		}
		return { line: 0, col: 0, message: msg };
	});

	return { errors };
}

/**
 * Enrich a type error with contextual documentation from JSDoc/descriptions.
 *
 * When an error occurs on a property assignment like `limit: 2`,
 * find the property's JSDoc in the type definitions and append it
 * so the LLM knows the expected format (e.g., "1d", "50").
 */
function enrichErrorMessage(
	msg: string,
	diagnostic: ts.Diagnostic,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker
): string {
	try {
		if (diagnostic.start === undefined) return msg;

		// Find the AST node at the error position
		const node = findNodeAtPosition(sourceFile, diagnostic.start);
		if (!node) return msg;

		// Case 1: Error on a property assignment value (e.g., `limit: 2`)
		// The error is on the value `2`, parent is PropertyAssignment
		const propAssignment = findParentOfKind(node, ts.SyntaxKind.PropertyAssignment);
		if (propAssignment && ts.isPropertyAssignment(propAssignment)) {
			const propName = propAssignment.name.getText(sourceFile);

			// Walk up to find the object literal, then the call expression,
			// then resolve the expected type to find the property's doc
			const objectLiteral = propAssignment.parent;
			if (objectLiteral && ts.isObjectLiteralExpression(objectLiteral)) {
				const contextualType = checker.getContextualType(objectLiteral);
				if (contextualType) {
					const propSymbol = contextualType.getProperty(propName);
					if (propSymbol) {
						const doc = ts.displayPartsToString(
							propSymbol.getDocumentationComment(checker)
						).trim();
						if (doc) {
							return msg + `\n  Hint: ${propName} — ${doc}`;
						}
					}
				}
			}
		}

		// Case 2: Error on the property name itself (e.g., unknown property)
		// Already handled well by TS ("does not exist in type '...'") with
		// the Did-you-mean suggestion. No enrichment needed.

	} catch {
		// Don't let enrichment errors break type checking
	}
	return msg;
}

/** Find the innermost AST node at a given position. */
function findNodeAtPosition(
	sourceFile: ts.SourceFile,
	position: number
): ts.Node | undefined {
	function visit(node: ts.Node): ts.Node | undefined {
		if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
			return undefined;
		}
		// Try children first (innermost wins)
		let best: ts.Node | undefined;
		ts.forEachChild(node, (child) => {
			const found = visit(child);
			if (found) best = found;
		});
		return best ?? node;
	}
	return visit(sourceFile);
}

/** Walk up the AST to find a parent of a specific kind. */
function findParentOfKind(
	node: ts.Node,
	kind: ts.SyntaxKind
): ts.Node | undefined {
	let current: ts.Node | undefined = node;
	while (current) {
		if (current.kind === kind) return current;
		current = current.parent;
	}
	return undefined;
}
