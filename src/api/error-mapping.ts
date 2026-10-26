import { HttpException } from "@nestjs/common";
import { IdempotencyConflictError } from "../application/errors";
import { DomainError } from "../domain/errors/domain-error";
import { ValidationError } from "./errors";

export interface ApiError {
	status: number;
	code: string;
	message: string;
	retriable: boolean;
	details?: unknown;
	retryAfterSeconds?: number;
}

const DOMAIN_STATUS: Record<string, number> = {
	INVALID_MONEY_AMOUNT: 400,
	INVALID_CURRENCY: 400,
	INVALID_AMOUNT: 400,
	INVALID_INITIAL_BALANCE: 400,
	REFERENCE_REQUIRED: 400,
	WALLET_NOT_FOUND: 404,
	TRANSACTION_NOT_FOUND: 404,
	WALLET_ALREADY_EXISTS: 409,
	IDEMPOTENCY_CONFLICT: 409,
};

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

export function mapError(error: unknown): ApiError {
	if (error instanceof ValidationError) {
		return {
			status: 400,
			code: error.code,
			message: error.message,
			retriable: false,
			details: error.issues,
		};
	}
	if (error instanceof IdempotencyConflictError) {
		return {
			status: 409,
			code: error.code,
			message: error.message,
			retriable: false,
			details: { reason: error.reason },
		};
	}
	if (error instanceof DomainError) {
		const status = DOMAIN_STATUS[error.code];
		if (status !== undefined) {
			return {
				status,
				code: error.code,
				message: error.message,
				retriable: false,
			};
		}
	}
	if (error instanceof HttpException) {
		const status = error.getStatus();
		const code =
			status === 404
				? "NOT_FOUND"
				: status === 400
					? "INVALID_REQUEST"
					: `HTTP_${status}`;
		return { status, code, message: error.message, retriable: status >= 500 };
	}
	if (isTransientInfrastructureError(error)) {
		return {
			status: 503,
			code: "SERVICE_UNAVAILABLE",
			message:
				"dependência temporariamente indisponível; reenvie a mesma requisição",
			retriable: true,
			retryAfterSeconds: 1,
		};
	}
	return {
		status: 500,
		code: "INTERNAL_ERROR",
		message: "erro interno",
		retriable: true,
	};
}
