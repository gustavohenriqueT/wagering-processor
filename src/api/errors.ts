import { DomainError } from "../domain/errors/domain-error";

export {
	type FieldIssue,
	ValidationError,
} from "../application/validation-error";

export class NotFoundError extends DomainError {
	constructor(
		code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND",
		message: string,
	) {
		super(code, message);
	}
}
