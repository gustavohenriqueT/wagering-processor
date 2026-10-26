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

const TRANSIENT_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"57P01",
	"57P03",
	"53300",
	"40001",
	"40P01",
	"55P03",
	"08000",
	"08001",
	"08003",
	"08006",
]);

export function isTransientInfrastructureError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const candidate = error as {
		code?: unknown;
		message?: unknown;
		errors?: unknown;
	};
	if (
		typeof candidate.code === "string" &&
		TRANSIENT_CODES.has(candidate.code)
	) {
		return true;
	}
	if (
		Array.isArray(candidate.errors) &&
		candidate.errors.some(isTransientInfrastructureError)
	) {
		return true;
	}
	return (
		typeof candidate.message === "string" &&
		/timeout exceeded when trying to connect/i.test(candidate.message)
	);
}
