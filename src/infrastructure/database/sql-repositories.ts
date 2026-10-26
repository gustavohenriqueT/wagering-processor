import type {
	LedgerRepository,
	StoredWagerTransaction,
	WagerTransactionRepository,
	WalletRepository,
} from "../../application/ports";
import { FailureCode } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import {
	WagerTransaction,
	WagerTransactionKind,
	WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import {
	date,
	enumValue,
	int,
	iso,
	optionalDate,
	optionalText,
	type Row,
	type SqlDb,
	text,
} from "./sql-db";

const WALLET_COLUMNS = `id, player_id, currency, balance, version::int as version,
  ${iso("created_at")} as created_at, ${iso("updated_at")} as updated_at`;

export class SqlWalletRepository implements WalletRepository {
	constructor(private readonly db: SqlDb) {}

	async insert(wallet: Wallet): Promise<void> {
		await this.db.exec(
			`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?::uuid, ?, ?, ?::numeric, ?, ?::timestamptz, ?::timestamptz)`,
			[
				wallet.id,
				wallet.playerId,
				wallet.currency,
				wallet.balance.toJSON().amount,
				wallet.version,
				wallet.createdAt.toISOString(),
				wallet.updatedAt.toISOString(),
			],
		);
	}

	async lockById(walletId: string): Promise<Wallet | undefined> {
		const rows = await this.db.query(
			`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?::uuid FOR UPDATE`,
			[walletId],
		);
		const row = rows[0];
		return row === undefined ? undefined : toWallet(row);
	}

	async save(wallet: Wallet, expectedVersion: number): Promise<void> {
		const affected = await this.db.exec(
			`UPDATE wallets
          SET balance = ?::numeric, version = ?, updated_at = ?::timestamptz
        WHERE id = ?::uuid AND version = ?`,
			[
				wallet.balance.toJSON().amount,
				wallet.version,
				wallet.updatedAt.toISOString(),
				wallet.id,
				expectedVersion,
			],
		);
		if (affected !== 1) {
			throw new Error(
				`conflito de version na wallet ${wallet.id}: esperada ${expectedVersion}`,
			);
		}
	}
}

function toWallet(row: Row): Wallet {
	const currency = text(row, "currency");
	return Wallet.rehydrate({
		id: text(row, "id"),
		playerId: text(row, "player_id"),
		currency,
		balance: Money.from({ amount: text(row, "balance"), currency }),
		version: int(row, "version"),
		createdAt: date(row, "created_at"),
		updatedAt: date(row, "updated_at"),
	});
}

const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount, currency,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  observed_balance, ${iso("created_at")} as created_at, ${iso("processed_at")} as processed_at`;

export class SqlWagerTransactionRepository
	implements WagerTransactionRepository
{
	constructor(private readonly db: SqlDb) {}

	async insert(
		transaction: WagerTransaction,
		observedBalance: Money | undefined,
	): Promise<void> {
		await this.db.exec(
			`INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          reference_external_transaction_id, reference_transaction_id, status, failure_code,
          observed_balance, created_at, processed_at)
       VALUES (?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?::numeric, ?, ?, ?::uuid, ?, ?,
               ?::numeric, ?::timestamptz, ?::timestamptz)`,
			[
				transaction.id,
				transaction.providerId,
				transaction.externalTransactionId,
				transaction.idempotencyKey,
				transaction.payloadHash,
				transaction.walletId,
				transaction.playerId,
				transaction.roundId,
				transaction.gameId,
				transaction.kind,
				transaction.money.toJSON().amount,
				transaction.money.currency,
				transaction.referenceExternalTransactionId ?? null,
				transaction.referenceTransactionId ?? null,
				transaction.status,
				transaction.failureCode ?? null,
				observedBalance?.toJSON().amount ?? null,
				transaction.createdAt.toISOString(),
				transaction.processedAt?.toISOString() ?? null,
			],
		);
	}

	findByIdempotencyKey(
		providerId: string,
		key: string,
	): Promise<StoredWagerTransaction | undefined> {
		return this.findOne("provider_id = ? AND idempotency_key = ?", [
			providerId,
			key,
		]);
	}

	findByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<StoredWagerTransaction | undefined> {
		return this.findOne("provider_id = ? AND external_transaction_id = ?", [
			providerId,
			externalTransactionId,
		]);
	}

	async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
		const rows = await this.db.query(
			`SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ?::uuid
          AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
        LIMIT 1`,
			[referenceTransactionId],
		);
		return rows.length > 0;
	}

	private async findOne(
		where: string,
		params: unknown[],
	): Promise<StoredWagerTransaction | undefined> {
		const rows = await this.db.query(
			`SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions WHERE ${where}`,
			params,
		);
		const row = rows[0];
		return row === undefined ? undefined : toStoredTransaction(row);
	}
}

function toStoredTransaction(row: Row): StoredWagerTransaction {
	const currency = text(row, "currency");
	const failureCode = optionalText(row, "failure_code");
	const observed = optionalText(row, "observed_balance");
	const transaction = WagerTransaction.rehydrate({
		id: text(row, "id"),
		providerId: text(row, "provider_id"),
		externalTransactionId: text(row, "external_transaction_id"),
		idempotencyKey: text(row, "idempotency_key"),
		payloadHash: text(row, "payload_hash"),
		walletId: text(row, "wallet_id"),
		playerId: text(row, "player_id"),
		roundId: text(row, "round_id"),
		gameId: text(row, "game_id"),
		kind: enumValue(WagerTransactionKind, text(row, "kind"), "kind"),
		money: Money.from({ amount: text(row, "amount"), currency }),
		referenceExternalTransactionId: optionalText(
			row,
			"reference_external_transaction_id",
		),
		createdAt: date(row, "created_at"),
		status: enumValue(WagerTransactionStatus, text(row, "status"), "status"),
		referenceTransactionId: optionalText(row, "reference_transaction_id"),
		failureCode:
			failureCode === undefined
				? undefined
				: enumValue(FailureCode, failureCode, "failure_code"),
		processedAt: optionalDate(row, "processed_at"),
	});
	return {
		transaction,
		observedBalance:
			observed === undefined
				? undefined
				: Money.from({ amount: observed, currency }),
	};
}

export class SqlLedgerRepository implements LedgerRepository {
	constructor(private readonly db: SqlDb) {}

	async insert(entry: WalletLedgerEntry): Promise<void> {
		await this.db.exec(
			`INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
       VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::numeric, ?::numeric, ?::numeric, ?::timestamptz)`,
			[
				entry.id,
				entry.walletId,
				entry.transactionId,
				entry.direction,
				entry.money.toJSON().amount,
				entry.balanceBefore.toJSON().amount,
				entry.balanceAfter.toJSON().amount,
				entry.createdAt.toISOString(),
			],
		);
	}
}
