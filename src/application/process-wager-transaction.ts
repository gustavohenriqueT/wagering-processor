import { DomainError } from "../domain/errors/domain-error";
import { FailureCode } from "../domain/failure-code";
import { InboxMessage } from "../domain/inbox-message";
import type { Money } from "../domain/money";
import {
	WagerTransaction,
	type WagerTransactionKind,
	WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import {
	LedgerDirection,
	type WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";
import { Metrics } from "../observability/metrics";
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
import {
	DEFAULT_PENDING_POLICY,
	type PendingReferencePolicy,
	pendingBackoffMs,
} from "./pending-reference-policy";
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
	inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerTransactionResult {
	transactionId: string;
	status: WagerTransactionStatus;
	failureCode?: FailureCode;
	balance: Money;
	idempotentReplay: boolean;
	replayedBy?: "idempotency-key" | "inbox";
}

interface Scope {
	context: UnitOfWorkContext;
	wallet: Wallet;
	transaction: WagerTransaction;
	now: Date;
	correlationId: string;
	causationId?: string;
	mode: "new" | "pending";
	pendingAttempts: number;
}

export class ProcessWagerTransaction {
	constructor(
		private readonly uow: UnitOfWork,
		private readonly clock: () => Date = () => new Date(),
		private readonly newId: () => string = () => crypto.randomUUID(),
		private readonly pendingPolicy: PendingReferencePolicy = DEFAULT_PENDING_POLICY,
		private readonly metrics: Metrics = new Metrics(),
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

	reprocessPending(
		transactionId: string,
	): Promise<ProcessWagerTransactionResult | undefined> {
		return this.uow.run(async (context) => {
			const preview = await context.transactions.findById(transactionId);
			if (
				preview === undefined ||
				preview.transaction.status !== WagerTransactionStatus.PendingReference
			) {
				return undefined;
			}
			const wallet = await this.lockWallet(
				context,
				preview.transaction.walletId,
			);
			const stored = await context.transactions.findById(transactionId);
			if (
				wallet === undefined ||
				stored === undefined ||
				stored.transaction.status !== WagerTransactionStatus.PendingReference
			) {
				return undefined;
			}
			return this.applyRules({
				context,
				wallet,
				transaction: stored.transaction,
				now: this.clock(),
				correlationId: `pending-reference:${transactionId}`,
				mode: "pending",
				pendingAttempts: stored.pendingAttempts,
			});
		});
	}

	private async processInTransaction(
		context: UnitOfWorkContext,
		command: ProcessWagerTransactionCommand,
		payloadHash: string,
	): Promise<ProcessWagerTransactionResult> {
		const wallet = await this.lockWallet(context, command.walletId);
		if (wallet === undefined) {
			throw new WalletNotFoundError(command.walletId);
		}
		const now = this.clock();

		if (command.inbox !== undefined) {
			const inboxMessage = InboxMessage.receive({
				messageId: command.inbox.messageId,
				consumerName: command.inbox.consumerName,
				payloadHash,
				receivedAt: now,
			});
			inboxMessage.markProcessed(now);
			const firstDelivery = await context.inbox.register(inboxMessage);
			if (!firstDelivery) {
				const already = await context.transactions.findByIdempotencyKey(
					command.providerId,
					command.idempotencyKey,
				);
				if (already !== undefined) {
					return this.replay(already, payloadHash, wallet, "inbox");
				}
			}
		}

		const existing = await context.transactions.findByIdempotencyKey(
			command.providerId,
			command.idempotencyKey,
		);
		if (existing !== undefined) {
			return this.replay(existing, payloadHash, wallet, "idempotency-key");
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
		const scope: Scope = {
			context,
			wallet,
			transaction,
			now,
			correlationId: command.correlationId,
			...(command.causationId === undefined
				? {}
				: { causationId: command.causationId }),
			mode: "new",
			pendingAttempts: 0,
		};

		if (command.playerId !== wallet.playerId) {
			return this.reject(scope, FailureCode.PlayerMismatch);
		}
		if (command.money.currency !== wallet.currency) {
			return this.reject(scope, FailureCode.CurrencyMismatch);
		}
		return this.applyRules(scope);
	}

	private async lockWallet(
		context: UnitOfWorkContext,
		walletId: string,
	): Promise<Wallet | undefined> {
		const startedAt = performance.now();
		const { wallet, contended } =
			await context.wallets.lockByIdReportingContention(walletId);
		this.metrics.observe(
			"wallet_lock_wait_seconds",
			(performance.now() - startedAt) / 1000,
		);
		if (contended) {
			this.metrics.inc("wallet_lock_conflicts_total");
		}
		return wallet;
	}

	private async applyRules(
		scope: Scope,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction, now } = scope;

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
				transaction.providerId,
				referenceExternalId,
			);
			if (stored === undefined) {
				return this.onMissingReference(scope);
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
			money: transaction.money,
			entryId: this.newId(),
			transactionId: transaction.id,
			at: now,
		};
		let entry: WalletLedgerEntry;
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
		await this.save(scope, wallet.balance);
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
				data: {
					...this.refs(transaction),
					balance: wallet.balance.toJSON(),
				},
			}),
		);
		return this.result(transaction, wallet.balance, false);
	}

	private save(
		scope: Scope,
		observedBalance: Money,
		schedule?: { attempts: number; nextAttemptAt: Date },
	): Promise<void> {
		const { context, transaction } = scope;
		return scope.mode === "new"
			? context.transactions.insert(transaction, observedBalance, schedule)
			: context.transactions.updateDecision(transaction, observedBalance);
	}

	private async onMissingReference(
		scope: Scope,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction, now } = scope;

		if (scope.mode === "new") {
			transaction.markPendingReference();
			await this.save(scope, wallet.balance, {
				attempts: 0,
				nextAttemptAt: new Date(
					now.getTime() + pendingBackoffMs(this.pendingPolicy, 0),
				),
			});
			await context.outbox.add(
				new WagerTransactionPendingReference({
					...this.eventProps(scope),
					data: {
						...this.refs(transaction),
						referenceExternalTransactionId:
							transaction.referenceExternalTransactionId ?? "",
					},
				}),
			);
			return this.result(transaction, wallet.balance, false);
		}

		const attempts = scope.pendingAttempts + 1;
		const ageMs = now.getTime() - transaction.createdAt.getTime();
		if (
			attempts >= this.pendingPolicy.maxAttempts ||
			ageMs >= this.pendingPolicy.ttlMs
		) {
			return this.reject(scope, FailureCode.ReferenceNotFound);
		}
		await context.transactions.schedulePendingRetry(transaction.id, {
			attempts,
			nextAttemptAt: new Date(
				now.getTime() + pendingBackoffMs(this.pendingPolicy, attempts),
			),
		});
		return this.result(transaction, wallet.balance, false);
	}

	private replay(
		existing: StoredWagerTransaction,
		payloadHash: string,
		wallet: Wallet,
		replayedBy: "idempotency-key" | "inbox",
	): ProcessWagerTransactionResult {
		if (!existing.transaction.matchesPayload(payloadHash)) {
			throw new IdempotencyConflictError(
				"PAYLOAD_MISMATCH",
				`a Idempotency-Key ${existing.transaction.idempotencyKey} já foi usada com outro payload`,
			);
		}
		return {
			...this.result(
				existing.transaction,
				existing.observedBalance ?? wallet.balance,
				true,
			),
			replayedBy,
		};
	}

	private async persistWithoutLedger(
		scope: Scope,
	): Promise<ProcessWagerTransactionResult> {
		const { context, wallet, transaction } = scope;
		await this.save(scope, wallet.balance);
		await context.outbox.add(
			new WagerTransactionProcessed({
				...this.eventProps(scope),
				data: {
					...this.refs(transaction),
					balance: wallet.balance.toJSON(),
				},
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
		await this.save(scope, wallet.balance);
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
			correlationId: scope.correlationId,
			...(scope.causationId === undefined
				? {}
				: { causationId: scope.causationId }),
			occurredAt: scope.now,
		};
	}
}
