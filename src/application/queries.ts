import type { MoneyProps } from "../domain/money";
import type { StoredWagerTransaction } from "./ports";

export interface WalletView {
	id: string;
	playerId: string;
	balance: MoneyProps;
	version: number;
}

export interface LedgerEntryView {
	id: string;
	transactionId: string;
	direction: string;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	createdAt: string;
}

export interface LedgerPage {
	entries: LedgerEntryView[];
	nextCursor?: string;
}

export interface TransactionView {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: MoneyProps;
	referenceExternalTransactionId?: string;
	status: string;
	failureCode?: string;
	balance?: MoneyProps;
	createdAt: string;
	processedAt?: string;
}

export interface ReconciliationView {
	walletId: string;
	storedBalance: MoneyProps;
	calculatedBalance: MoneyProps;
	difference: MoneyProps;
	consistent: boolean;
	checkedEntries: number;
}

export interface QueryPort {
	findWallet(walletId: string): Promise<WalletView | undefined>;
	listLedger(
		walletId: string,
		afterSeq: string | undefined,
		limit: number,
	): Promise<LedgerPage | undefined>;
	findTransactionById(
		transactionId: string,
	): Promise<TransactionView | undefined>;
	findTransactionByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<TransactionView | undefined>;
	reconcile(walletId: string): Promise<ReconciliationView | undefined>;
}

export function toTransactionView(
	stored: StoredWagerTransaction,
): TransactionView {
	const { transaction, observedBalance } = stored;
	return {
		transactionId: transaction.id,
		providerId: transaction.providerId,
		externalTransactionId: transaction.externalTransactionId,
		walletId: transaction.walletId,
		playerId: transaction.playerId,
		roundId: transaction.roundId,
		gameId: transaction.gameId,
		kind: transaction.kind,
		money: transaction.money.toJSON(),
		...(transaction.referenceExternalTransactionId === undefined
			? {}
			: {
					referenceExternalTransactionId:
						transaction.referenceExternalTransactionId,
				}),
		status: transaction.status,
		...(transaction.failureCode === undefined
			? {}
			: { failureCode: transaction.failureCode }),
		...(observedBalance === undefined
			? {}
			: { balance: observedBalance.toJSON() }),
		createdAt: transaction.createdAt.toISOString(),
		...(transaction.processedAt === undefined
			? {}
			: { processedAt: transaction.processedAt.toISOString() }),
	};
}
