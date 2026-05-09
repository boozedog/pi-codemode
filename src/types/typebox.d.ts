// Stub type declarations for @sinclair/typebox
// Provided by Pi at runtime; minimal declaration for compilation.

declare module "@sinclair/typebox" {
	export const Type: {
		Object<T extends Record<string, unknown>>(
			properties: T,
			options?: { description?: string }
		): unknown;
		String(options?: { description?: string }): unknown;
		Optional<T>(schema: T): unknown;
		Record<K extends unknown, V extends unknown>(
			keySchema: K,
			valueSchema: V,
			options?: { description?: string }
		): unknown;
	};
}
