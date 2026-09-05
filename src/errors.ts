/**
 * Produces a non-empty, human-readable description of an unknown thrown value.
 *
 * Some driver errors (notably pg connection resets) carry an empty `message`,
 * which would otherwise surface as a useless blank reason in /health output —
 * so fall back through the error's code, then its name, then its stringified form.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) {
		if (error.message) {
			return error.message;
		}
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code) {
			return `${error.name} (code ${code})`;
		}
		if (error.name) {
			return error.name;
		}
	}
	const asString = String(error);
	return asString === "" || asString === "[object Object]" ? "unknown error" : asString;
}
