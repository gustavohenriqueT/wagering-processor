import type { Money } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { IntegrationEvent } from "./events/integration-event";

export interface StoredWagerTransaction {
	transaction: WagerTransaction;
	observedBalance: Money | undefined;
}

export interface WalletRepository {
	insert(wallet: Wallet): Promise<void>;
	lockById(walletId: string): Promise<Wallet | undefined>;
	save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
	insert(
		transaction: WagerTransaction,
		observedBalance: Money | undefined,
	): Promise<void>;
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

export interface OutboxRepository {
	add(event: IntegrationEvent<unknown>): Promise<void>;
}

export interface UnitOfWorkContext {
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
}

export interface UnitOfWork {
	run<T>(work: (context: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
