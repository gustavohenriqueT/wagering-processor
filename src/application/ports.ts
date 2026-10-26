import type { Money } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { IntegrationEvent } from "./events/integration-event";

export interface StoredWagerTransaction {
	transaction: WagerTransaction;
	observedBalance: Money | undefined;
	pendingAttempts: number;
}

export interface PendingSchedule {
	attempts: number;
	nextAttemptAt: Date;
}

export interface WalletRepository {
	insert(wallet: Wallet): Promise<void>;
	lockById(walletId: string): Promise<Wallet | undefined>;
	lockByIdReportingContention(
		walletId: string,
	): Promise<{ wallet: Wallet | undefined; contended: boolean }>;
	save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
	insert(
		transaction: WagerTransaction,
		observedBalance: Money | undefined,
		schedule?: PendingSchedule,
	): Promise<void>;
	updateDecision(
		transaction: WagerTransaction,
		observedBalance: Money | undefined,
	): Promise<void>;
	schedulePendingRetry(
		transactionId: string,
		schedule: PendingSchedule,
	): Promise<void>;
	listDuePendingReference(now: Date, limit: number): Promise<string[]>;
	findById(id: string): Promise<StoredWagerTransaction | undefined>;
	findByIdempotencyKey(
		providerId: string,
		key: string,
	): Promise<StoredWagerTransaction | undefined>;
	findByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<StoredWagerTransaction | undefined>;
	hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface LedgerRepository {
	insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRecord {
	id: string;
	aggregateId: string;
	eventType: string;
	payload: string;
	attempts: number;
}

export interface OutboxRepository {
	add(event: IntegrationEvent<unknown>): Promise<void>;
	claimPending(now: Date, limit: number): Promise<OutboxRecord[]>;
	markPublished(id: string, at: Date): Promise<void>;
	markFailed(id: string, nextAttemptAt: Date): Promise<void>;
	oldestPendingAgeSeconds(): Promise<number | undefined>;
}

export interface InboxRepository {
	register(
		consumerName: string,
		messageId: string,
		payloadHash: string,
		at: Date,
	): Promise<boolean>;
}

export interface UnitOfWorkContext {
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
	inbox: InboxRepository;
}

export interface UnitOfWork {
	run<T>(work: (context: UnitOfWorkContext) => Promise<T>): Promise<T>;
}

export interface EventPublisher {
	publish(message: {
		eventId: string;
		groupId: string;
		body: string;
	}): Promise<void>;
}
