import type { Money } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { IntegrationEvent } from "./events/integration-event";

/** Transação já persistida, com o saldo observado no momento em que foi decidida. */
export interface StoredWagerTransaction {
	transaction: WagerTransaction;
	observedBalance: Money | undefined;
}

export interface WalletRepository {
	insert(wallet: Wallet): Promise<void>;
	/** SELECT ... FOR UPDATE: bloqueia a linha até o fim da transação SQL. */
	lockById(walletId: string): Promise<Wallet | undefined>;
	/** Persiste saldo e version. Falha se a version no banco não for `expectedVersion`. */
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
	/** Grava o evento na outbox, na mesma transação SQL do restante. */
	add(event: IntegrationEvent<unknown>): Promise<void>;
}

/** Tudo que um caso de uso pode tocar dentro de UMA transação SQL. */
export interface UnitOfWorkContext {
	wallets: WalletRepository;
	transactions: WagerTransactionRepository;
	ledger: LedgerRepository;
	outbox: OutboxRepository;
}

export interface UnitOfWork {
	/** Roda `work` em uma transação SQL: commit se resolver, rollback se lançar. */
	run<T>(work: (context: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
