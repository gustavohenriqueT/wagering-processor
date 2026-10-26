import { DomainError } from "./domain-error";

export class InvalidTransactionStateError extends DomainError {
	constructor(from: string, to: string) {
		super("INVALID_TRANSACTION_STATE", `transição inválida: ${from} -> ${to}`);
	}
}
