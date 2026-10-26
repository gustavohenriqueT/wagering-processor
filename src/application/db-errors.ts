export function uniqueViolation(
	error: unknown,
): { constraint: string | undefined } | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const candidate = error as { code?: unknown; constraint?: unknown };
	if (candidate.code !== "23505") {
		return undefined;
	}
	return {
		constraint:
			typeof candidate.constraint === "string"
				? candidate.constraint
				: undefined,
	};
}
