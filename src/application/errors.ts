import { DomainError } from "../domain/errors/domain-error";

export class WalletNotFoundError extends DomainError {
	constructor(walletId: string) {
		super("WALLET_NOT_FOUND", `wallet ${walletId} não encontrada`);
	}
}

export class WalletAlreadyExistsError extends DomainError {
	constructor(playerId: string, currency: string) {
		super(
			"WALLET_ALREADY_EXISTS",
			`já existe wallet ${currency} para o jogador ${playerId}`,
		);
	}
}

export type IdempotencyConflictReason =
	| "PAYLOAD_MISMATCH"
	| "EXTERNAL_ID_REUSED";

export class IdempotencyConflictError extends DomainError {
	constructor(
		public readonly reason: IdempotencyConflictReason,
		message: string,
	) {
		super("IDEMPOTENCY_CONFLICT", message);
	}
}
