import { DomainError } from "../domain/errors/domain-error";
import { FailureCode } from "../domain/failure-code";
import type { Money } from "../domain/money";
import {
	WagerTransaction,
	type WagerTransactionKind,
	type WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { uniqueViolation } from "./db-errors";
import { IdempotencyConflictError, WalletNotFoundError } from "./errors";
import type { IntegrationEventProps } from "./events/integration-event";
import {
	WagerTransactionPendingReference,
	WagerTransactionProcessed,
	WagerTransactionRejected,
	WalletBalanceChanged,
} from "./events/wager-events";
import { computePayloadHash } from "./payload-hash";
import type {
	StoredWagerTransaction,
	UnitOfWork,
	UnitOfWorkContext,
} from "./ports";

export interface ProcessWagerTransactionCommand {
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	referenceExternalTransactionId?: string;
	correlationId: string;
	causationId?: string;
}

export interface ProcessWagerTransactionResult {
	transactionId: string;
	status: WagerTransactionStatus;
	failureCode?: FailureCode;
	balance: Money;
	idempotentReplay: boolean;
}

export class ProcessWagerTransaction {
	constructor(
		private readonly uow: UnitOfWork,
		private readonly clock: () => Date = () => new Date(),
		private readonly newId: () => string = () => crypto.randomUUID(),
	) {}

	async execute(
		command: ProcessWagerTransactionCommand,
	): Promise<ProcessWagerTransactionResult> {
		const payloadHash = computePayloadHash(command);
		try {
			return await this.uow.run((context) =>
				this.processInTransaction(context, command, payloadHash),
			);
		} catch (error) {
			if (uniqueViolation(error) !== undefined) {
				return this.uow.run((context) =>
					this.processInTransaction(context, command, payloadHash),
				);
			}
			throw error;
		}
	}

	private async processInTransaction(
		context: UnitOfWorkContext,
		command: ProcessWagerTransactionCommand,
		payloadHash: string,
	): Promise<ProcessWagerTransactionResult> {
		const wallet = await context.wallets.lockById(command.walletId);
		if (wallet === undefined) {
			throw new WalletNotFoundError(command.walletId);
		}

		const existing = await context.transactions.findByIdempotencyKey(
			command.providerId,
			command.idempotencyKey,
		);
		if (existing !== undefined) {
			return this.replay(existing, payloadHash, wallet);
		}
		const reused = await context.transactions.findByExternalId(
			command.providerId,
			command.externalTransactionId,
		);
		if (reused !== undefined) {
			throw new IdempotencyConflictError(
				"EXTERNAL_ID_REUSED",
				`externalTransactionId ${command.externalTransactionId} já foi usado com outra Idempotency-Key`,
			);
		}

		const now = this.clock();
		const transaction = WagerTransaction.create({
			id: this.newId(),
			providerId: command.providerId,
			externalTransactionId: command.externalTransactionId,
			idempotencyKey: command.idempotencyKey,
			payloadHash,
			walletId: command.walletId,
			playerId: command.playerId,
			roundId: command.roundId,
			gameId: command.gameId,
			kind: command.kind,
			money: command.money,
			referenceExternalTransactionId: command.referenceExternalTransactionId,
			createdAt: now,
		});
		const scope: Scope = { context, command, wallet, transaction, now };

		if (command.playerId !== wallet.playerId) {
			return this.reject(scope, FailureCode.PlayerMismatch);
		}
		if (command.money.currency !== wallet.currency) {
			return this.reject(scope, FailureCode.CurrencyMismatch);
		}

		if (!transaction.affectsBalance()) {
			transaction.markProcessed(undefined, now);
			return this.persistWithoutLedger(scope);
		}

		let reference: WagerTransaction | undefined;
		if (transaction.requiresReference()) {
			const referenceExternalId = transaction.referenceExternalTransactionId;
			if (referenceExternalId === undefined) {
				throw new DomainError("REFERENCE_REQUIRED", "reversão sem referência");
			}
			const stored = await context.transactions.findByExternalId(
				command.providerId,
				referenceExternalId,
			);
			if (stored === undefined) {
				return this.pendingReference(scope, referenceExternalId);
			}
			reference = stored.transaction;

			const code = transaction.checkReference(reference);
			if (code !== undefined) {
				return this.reject(scope, code);
			}
			if (await context.transactions.hasProcessedReversal(reference.id)) {
				return this.reject(scope, FailureCode.AlreadyReversed);
			}
		}

		const previousVersion = wallet.version;
		const direction = transaction.ledgerDirectionFor(reference);
		const movement = {
			money: command.money,
			entryId: this.newId(),
			transactionId: transaction.id,
			at: now,
		};

		let entry;
		try {
			entry =
				direction === LedgerDirection.Debit
					? wallet.debit(movement)
					: wallet.credit(movement);
		} catch (error) {
			if (error instanceof DomainError && error.code === "INSUFFICIENT_FUNDS") {
				return this.reject(
					scope,
					transaction.requiresReference()
						? FailureCode.ReversalWouldOverdraw
						: FailureCode.InsufficientFunds,
				);
			}
			throw error;
		}

		transaction.markProcessed(reference?.id, now);
		await context.transactions.insert(transaction, wallet.balance);
		await context.ledger.insert(entry);
		await context.wallets.save(wallet, previousVersion);
		await context.outbox.add(
			new WalletBalanceChanged({
				...this.eventProps(scope),
				data: {
					walletId: wallet.id,
					transactionId: transaction.id,
					direction: entry.direction,
					money: entry.money.toJSON(),
					balanceBefore: entry.balanceBefore.toJSON(),
					balanceAfter: entry.balanceAfter.toJSON(),
					walletVersion: wallet.version,
				},
			}),
		);
		await context.outbox.add(
			new WagerTransactionProcessed({
				...this.eventProps(scope),
				data: { ...this.refs(transaction), balance: wallet.balance.toJSON() },
			}),
		);
		return this.result(transaction, wallet.balance, false);
	}

	private replay(
		existing: StoredWagerTransaction,
		payloadHash: string,
		wallet: Wallet,
	): ProcessWagerTransactionResult {
		if (!existing.transaction.matchesPayload(payloadHash)) {
			throw new IdempotencyConflictError(
				"PAYLOAD_MISMATCH",
				`a Idempotency-Key ${existing.transaction.idempotencyKey} já foi usada com outro payload`,
			);
		}
		return this.result(
			existing.transaction,
			existing.observedBalance ?? wallet.balance,
			true,
		);
	}

	private async persistWithoutLedger(
		scope: Scope,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction } = scope;
		await context.transactions.insert(transaction, wallet.balance);
		await context.outbox.add(
			new WagerTransactionProcessed({
				...this.eventProps(scope),
				data: { ...this.refs(transaction), balance: wallet.balance.toJSON() },
			}),
		);
		return this.result(transaction, wallet.balance, false);
	}

	private async reject(
		scope: Scope,
		code: FailureCode,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction } = scope;
		transaction.reject(code);
		await context.transactions.insert(transaction, wallet.balance);
		await context.outbox.add(
			new WagerTransactionRejected({
				...this.eventProps(scope),
				data: {
					...this.refs(transaction),
					failureCode: code,
					balance: wallet.balance.toJSON(),
				},
			}),
		);
		return this.result(transaction, wallet.balance, false);
	}

	private async pendingReference(
		scope: Scope,
		referenceExternalId: string,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction } = scope;
		transaction.markPendingReference();
		await context.transactions.insert(transaction, wallet.balance);
		await context.outbox.add(
			new WagerTransactionPendingReference({
				...this.eventProps(scope),
				data: {
					...this.refs(transaction),
					referenceExternalTransactionId: referenceExternalId,
				},
			}),
		);
		return this.result(transaction, wallet.balance, false);
	}

	private result(
		transaction: WagerTransaction,
		balance: Money,
		idempotentReplay: boolean,
	): ProcessWagerTransactionResult {
		return {
			transactionId: transaction.id,
			status: transaction.status,
			...(transaction.failureCode === undefined
				? {}
				: { failureCode: transaction.failureCode }),
			balance,
			idempotentReplay,
		};
	}

	private refs(transaction: WagerTransaction) {
		return {
			transactionId: transaction.id,
			walletId: transaction.walletId,
			providerId: transaction.providerId,
			externalTransactionId: transaction.externalTransactionId,
			kind: transaction.kind,
			money: transaction.money.toJSON(),
		};
	}

	private eventProps(scope: Scope): Omit<IntegrationEventProps<never>, "data"> {
		return {
			eventId: this.newId(),
			aggregateId: scope.wallet.id,
			correlationId: scope.command.correlationId,
			...(scope.command.causationId === undefined
				? {}
				: { causationId: scope.command.causationId }),
			occurredAt: scope.now,
		};
	}
}

interface Scope {
	context: UnitOfWorkContext;
	command: ProcessWagerTransactionCommand;
	wallet: Wallet;
	transaction: WagerTransaction;
	now: Date;
}
