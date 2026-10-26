import { DomainError } from "./errors/domain-error";
import { InvalidTransactionStateError } from "./errors/invalid-transaction-state-error";
import { FailureCode } from "./failure-code";
import type { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
	Opening = "OPENING",
	Bet = "BET",
	Win = "WIN",
	Loss = "LOSS",
	Refund = "REFUND",
	Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
	Pending = "PENDING",
	PendingReference = "PENDING_REFERENCE",
	Processed = "PROCESSED",
	Rejected = "REJECTED",
	Failed = "FAILED",
}

const ALLOWED_TRANSITIONS: Record<
	WagerTransactionStatus,
	readonly WagerTransactionStatus[]
> = {
	[WagerTransactionStatus.Pending]: [
		WagerTransactionStatus.PendingReference,
		WagerTransactionStatus.Processed,
		WagerTransactionStatus.Rejected,
		WagerTransactionStatus.Failed,
	],
	[WagerTransactionStatus.PendingReference]: [
		WagerTransactionStatus.Processed,
		WagerTransactionStatus.Rejected,
		WagerTransactionStatus.Failed,
	],
	[WagerTransactionStatus.Processed]: [],
	[WagerTransactionStatus.Rejected]: [],
	[WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
	id: string;
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	payloadHash: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	referenceExternalTransactionId?: string;
	createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
	status: WagerTransactionStatus;
	referenceTransactionId?: string;
	failureCode?: FailureCode;
	processedAt?: Date;
}

export class WagerTransaction {
	private constructor(
		public readonly id: string,
		public readonly providerId: string,
		public readonly externalTransactionId: string,
		public readonly idempotencyKey: string,
		public readonly payloadHash: string,
		public readonly walletId: string,
		public readonly playerId: string,
		public readonly roundId: string,
		public readonly gameId: string,
		public readonly kind: WagerTransactionKind,
		public readonly money: Money,
		public readonly referenceExternalTransactionId: string | undefined,
		public readonly createdAt: Date,
		private _status: WagerTransactionStatus,
		private _referenceTransactionId?: string,
		private _failureCode?: FailureCode,
		private _processedAt?: Date,
	) {}

	static create(props: CreateWagerTransactionProps): WagerTransaction {
		const reversal =
			props.kind === WagerTransactionKind.Refund ||
			props.kind === WagerTransactionKind.Rollback;
		if (reversal && !props.referenceExternalTransactionId) {
			throw new DomainError(
				"REFERENCE_REQUIRED",
				`${props.kind} exige referenceExternalTransactionId`,
			);
		}
		if (props.money.isNegative()) {
			throw new DomainError(
				"INVALID_AMOUNT",
				"o valor da transação não pode ser negativo",
			);
		}
		if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
			throw new DomainError(
				"INVALID_AMOUNT",
				`${props.kind} exige valor maior que zero`,
			);
		}
		return new WagerTransaction(
			props.id,
			props.providerId,
			props.externalTransactionId,
			props.idempotencyKey,
			props.payloadHash,
			props.walletId,
			props.playerId,
			props.roundId,
			props.gameId,
			props.kind,
			props.money,
			props.referenceExternalTransactionId,
			props.createdAt,
			WagerTransactionStatus.Pending,
		);
	}

	static rehydrate(state: WagerTransactionState): WagerTransaction {
		return new WagerTransaction(
			state.id,
			state.providerId,
			state.externalTransactionId,
			state.idempotencyKey,
			state.payloadHash,
			state.walletId,
			state.playerId,
			state.roundId,
			state.gameId,
			state.kind,
			state.money,
			state.referenceExternalTransactionId,
			state.createdAt,
			state.status,
			state.referenceTransactionId,
			state.failureCode,
			state.processedAt,
		);
	}

	get status(): WagerTransactionStatus {
		return this._status;
	}

	get referenceTransactionId(): string | undefined {
		return this._referenceTransactionId;
	}

	get failureCode(): FailureCode | undefined {
		return this._failureCode;
	}

	get processedAt(): Date | undefined {
		return this._processedAt;
	}

	markProcessed(referenceTransactionId: string | undefined, at: Date): void {
		if (this.requiresReference() && referenceTransactionId === undefined) {
			throw new DomainError(
				"REFERENCE_REQUIRED",
				`${this.kind} só pode ser processada com o id da transação referenciada`,
			);
		}
		this.transitionTo(WagerTransactionStatus.Processed);
		this._referenceTransactionId = referenceTransactionId;
		this._processedAt = at;
	}

	markPendingReference(): void {
		this.transitionTo(WagerTransactionStatus.PendingReference);
	}

	reject(code: FailureCode): void {
		this.transitionTo(WagerTransactionStatus.Rejected);
		this._failureCode = code;
	}

	fail(code: FailureCode): void {
		this.transitionTo(WagerTransactionStatus.Failed);
		this._failureCode = code;
	}

	isTerminal(): boolean {
		return ALLOWED_TRANSITIONS[this._status].length === 0;
	}

	affectsBalance(): boolean {
		return this.kind !== WagerTransactionKind.Loss;
	}

	requiresReference(): boolean {
		return (
			this.kind === WagerTransactionKind.Refund ||
			this.kind === WagerTransactionKind.Rollback
		);
	}

	matchesPayload(payloadHash: string): boolean {
		return this.payloadHash === payloadHash;
	}

	ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
		switch (this.kind) {
			case WagerTransactionKind.Bet:
				return LedgerDirection.Debit;
			case WagerTransactionKind.Opening:
			case WagerTransactionKind.Win:
			case WagerTransactionKind.Refund:
				return LedgerDirection.Credit;
			case WagerTransactionKind.Loss:
				throw new DomainError(
					"NO_LEDGER_EFFECT",
					"LOSS não move saldo e não gera lançamento",
				);
			case WagerTransactionKind.Rollback: {
				if (reference === undefined) {
					throw new DomainError(
						"REFERENCE_REQUIRED",
						"ROLLBACK precisa da transação referenciada",
					);
				}
				const original = reference.ledgerDirectionFor();
				return original === LedgerDirection.Debit
					? LedgerDirection.Credit
					: LedgerDirection.Debit;
			}
		}
	}

	checkReference(reference: WagerTransaction): FailureCode | undefined {
		if (!this.requiresReference()) {
			return undefined;
		}

		const allowedKinds =
			this.kind === WagerTransactionKind.Refund
				? [WagerTransactionKind.Bet]
				: [
						WagerTransactionKind.Bet,
						WagerTransactionKind.Win,
						WagerTransactionKind.Refund,
					];
		if (!allowedKinds.includes(reference.kind)) {
			return FailureCode.InvalidReferenceKind;
		}

		const sameContext =
			reference.providerId === this.providerId &&
			reference.playerId === this.playerId &&
			reference.walletId === this.walletId &&
			reference.roundId === this.roundId &&
			reference.money.currency === this.money.currency;
		if (!sameContext) {
			return FailureCode.ReferenceMismatch;
		}

		if (reference.status !== WagerTransactionStatus.Processed) {
			return FailureCode.ReferenceNotProcessed;
		}

		if (!this.money.equals(reference.money)) {
			return FailureCode.AmountMismatch;
		}

		return undefined;
	}

	private transitionTo(next: WagerTransactionStatus): void {
		if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
			throw new InvalidTransactionStateError(this._status, next);
		}
		this._status = next;
	}
}
