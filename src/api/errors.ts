import { DomainError } from "../domain/errors/domain-error";

export interface FieldIssue {
	field: string;
	message: string;
}

export class ValidationError extends DomainError {
	constructor(public readonly issues: FieldIssue[]) {
		super("VALIDATION_ERROR", "requisição inválida");
	}
}

export class NotFoundError extends DomainError {
	constructor(
		code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND",
		message: string,
	) {
		super(code, message);
	}
}
