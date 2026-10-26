import type { MikroORM } from "@mikro-orm/postgresql";
import {
	type LedgerPage,
	type QueryPort,
	type ReconciliationView,
	type TransactionView,
	toTransactionView,
	type WalletView,
} from "../../application/queries";
import { int, iso, SqlDb, text } from "./sql-db";
import { SqlWagerTransactionRepository } from "./sql-repositories";

export class SqlQueries implements QueryPort {
	constructor(private readonly orm: MikroORM) {}

	private db(): SqlDb {
		return new SqlDb(this.orm.em.fork());
	}

	async findWallet(walletId: string): Promise<WalletView | undefined> {
		const rows = await this.db().query(
			"SELECT id, player_id, currency, balance, version::int AS version FROM wallets WHERE id = ?::uuid",
			[walletId],
		);
		const row = rows[0];
		if (row === undefined) {
			return undefined;
		}
		return {
			id: text(row, "id"),
			playerId: text(row, "player_id"),
			balance: {
				amount: text(row, "balance"),
				currency: text(row, "currency"),
			},
			version: int(row, "version"),
		};
	}

	async listLedger(
		walletId: string,
		afterSeq: string | undefined,
		limit: number,
	): Promise<LedgerPage | undefined> {
		const db = this.db();
		const exists = await db.query(
			"SELECT 1 AS found FROM wallets WHERE id = ?::uuid",
			[walletId],
		);
		if (exists.length === 0) {
			return undefined;
		}
		const rows = await db.query(
			`SELECT l.seq::text AS seq, l.id, l.transaction_id, l.direction, l.amount, l.balance_before,
              l.balance_after, w.currency, ${iso("l.created_at")} AS created_at
         FROM wallet_ledger_entries l
         JOIN wallets w ON w.id = l.wallet_id
        WHERE l.wallet_id = ?::uuid AND (?::bigint IS NULL OR l.seq > ?::bigint)
        ORDER BY l.seq
        LIMIT ?`,
			[walletId, afterSeq ?? null, afterSeq ?? null, limit + 1],
		);
		const page = rows.slice(0, limit);
		const entries = page.map((row) => {
			const currency = text(row, "currency");
			return {
				id: text(row, "id"),
				transactionId: text(row, "transaction_id"),
				direction: text(row, "direction"),
				money: { amount: text(row, "amount"), currency },
				balanceBefore: { amount: text(row, "balance_before"), currency },
				balanceAfter: { amount: text(row, "balance_after"), currency },
				createdAt: text(row, "created_at"),
			};
		});
		const last = page[page.length - 1];
		return rows.length > limit && last !== undefined
			? { entries, nextCursor: text(last, "seq") }
			: { entries };
	}

	async findTransactionById(
		transactionId: string,
	): Promise<TransactionView | undefined> {
		const stored = await new SqlWagerTransactionRepository(this.db()).findById(
			transactionId,
		);
		return stored === undefined ? undefined : toTransactionView(stored);
	}

	async findTransactionByExternalId(
		providerId: string,
		externalTransactionId: string,
	): Promise<TransactionView | undefined> {
		const stored = await new SqlWagerTransactionRepository(
			this.db(),
		).findByExternalId(providerId, externalTransactionId);
		return stored === undefined ? undefined : toTransactionView(stored);
	}

	async reconcile(walletId: string): Promise<ReconciliationView | undefined> {
		const rows = await this.db().query(
			`SELECT w.currency,
              w.balance::text AS stored,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS calculated,
              (w.balance - COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0))::numeric(19,2)::text AS difference,
              COUNT(l.id)::int AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?::uuid
        GROUP BY w.id`,
			[walletId],
		);
		const row = rows[0];
		if (row === undefined) {
			return undefined;
		}
		const currency = text(row, "currency");
		const difference = text(row, "difference");
		return {
			walletId,
			storedBalance: { amount: text(row, "stored"), currency },
			calculatedBalance: { amount: text(row, "calculated"), currency },
			difference: { amount: difference, currency },
			consistent: difference === "0.00",
			checkedEntries: int(row, "entries"),
		};
	}
}
