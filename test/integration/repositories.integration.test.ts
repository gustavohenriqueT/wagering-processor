import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletBalanceChanged } from "../../src/application/events/wager-events";
import { FailureCode } from "../../src/domain/failure-code";
import { Money } from "../../src/domain/money";
import {
	WagerTransaction,
	WagerTransactionKind,
	WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { SqlUnitOfWork } from "../../src/infrastructure/database/sql-unit-of-work";
import { createTestOrm, sleep, truncateAll } from "./support/test-database";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-25T12:00:00.000Z");
const t1 = new Date("2026-10-25T12:01:00.000Z");

let orm: MikroORM;
let uow: SqlUnitOfWork;

beforeAll(async () => {
	orm = await createTestOrm();
	uow = new SqlUnitOfWork(orm);
});

afterAll(async () => {
	await orm.close();
});

beforeEach(async () => {
	await truncateAll(orm);
});

async function seedWallet(balance = "100.00"): Promise<string> {
	const wallet = Wallet.open({
		id: crypto.randomUUID(),
		playerId: "player-1",
		initialBalance: brl(balance),
		now: t0,
	});
	await uow.run(({ wallets }) => wallets.insert(wallet));
	return wallet.id;
}

function newBet(walletId: string, external = "ext-1"): WagerTransaction {
	return WagerTransaction.create({
		id: crypto.randomUUID(),
		providerId: "prov-a",
		externalTransactionId: external,
		idempotencyKey: `prov-a:${external}`,
		payloadHash: "hash",
		walletId,
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind: WagerTransactionKind.Bet,
		money: brl("30.00"),
		createdAt: t0,
	});
}

describe("SqlWalletRepository", () => {
	test("insert + lockById fazem o roundtrip com tipos corretos", async () => {
		const id = await seedWallet("100.00");
		const loaded = await uow.run(({ wallets }) => wallets.lockById(id));
		expect(loaded?.balance.toJSON()).toEqual({
			amount: "100.00",
			currency: "BRL",
		});
		expect(loaded?.version).toBe(1);
		expect(loaded?.createdAt.toISOString()).toBe(t0.toISOString());
	});

	test("lockById devolve undefined para wallet inexistente", async () => {
		const found = await uow.run(({ wallets }) =>
			wallets.lockById(crypto.randomUUID()),
		);
		expect(found).toBeUndefined();
	});

	test("save persiste saldo e version; version errada falha", async () => {
		const id = await seedWallet("100.00");
		await uow.run(async ({ wallets }) => {
			const wallet = await wallets.lockById(id);
			if (wallet === undefined) throw new Error("wallet sumiu");
			wallet.debit({
				money: brl("30.00"),
				entryId: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				at: t1,
			});
			await wallets.save(wallet, 1);
		});
		const after = await uow.run(({ wallets }) => wallets.lockById(id));
		expect(after?.balance.toJSON().amount).toBe("70.00");
		expect(after?.version).toBe(2);

		const stale = Wallet.rehydrate({
			id,
			playerId: "player-1",
			currency: "BRL",
			balance: brl("1.00"),
			version: 2,
			createdAt: t0,
			updatedAt: t1,
		});
		await expect(
			uow.run(({ wallets }) => wallets.save(stale, 1)),
		).rejects.toThrow("conflito de version");
	});
});

describe("SqlWagerTransactionRepository", () => {
	test("roundtrip de transação rejeitada, com saldo observado", async () => {
		const walletId = await seedWallet();
		const tx = newBet(walletId);
		tx.reject(FailureCode.InsufficientFunds);
		await uow.run(({ transactions }) => transactions.insert(tx, brl("100.00")));

		const found = await uow.run(({ transactions }) =>
			transactions.findByIdempotencyKey("prov-a", "prov-a:ext-1"),
		);
		expect(found?.transaction.status).toBe(WagerTransactionStatus.Rejected);
		expect(found?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(found?.observedBalance?.toJSON().amount).toBe("100.00");
		expect(found?.transaction.money.toJSON().amount).toBe("30.00");
	});

	test("findByExternalId encontra; chave inexistente devolve undefined", async () => {
		const walletId = await seedWallet();
		await uow.run(({ transactions }) =>
			transactions.insert(newBet(walletId), undefined),
		);
		const hit = await uow.run(({ transactions }) =>
			transactions.findByExternalId("prov-a", "ext-1"),
		);
		const miss = await uow.run(({ transactions }) =>
			transactions.findByExternalId("prov-a", "nope"),
		);
		expect(hit?.transaction.externalTransactionId).toBe("ext-1");
		expect(hit?.observedBalance).toBeUndefined();
		expect(miss).toBeUndefined();
	});

	test("o banco recusa a mesma idempotency key (unicidade é do schema)", async () => {
		const walletId = await seedWallet();
		await uow.run(({ transactions }) =>
			transactions.insert(newBet(walletId), undefined),
		);
		const duplicate = newBet(walletId, "ext-2");
		const clash = WagerTransaction.create({
			id: crypto.randomUUID(),
			providerId: "prov-a",
			externalTransactionId: "ext-2",
			idempotencyKey: "prov-a:ext-1",
			payloadHash: "hash",
			walletId,
			playerId: "player-1",
			roundId: "round-1",
			gameId: "game-1",
			kind: WagerTransactionKind.Bet,
			money: brl("30.00"),
			createdAt: t0,
		});
		expect(duplicate.idempotencyKey).not.toBe(clash.idempotencyKey);
		await expect(
			uow.run(({ transactions }) => transactions.insert(clash, undefined)),
		).rejects.toThrow(/uq_tx_idempotency/);
	});

	test("hasProcessedReversal enxerga estorno processado", async () => {
		const walletId = await seedWallet();
		const bet = newBet(walletId);
		bet.markProcessed(undefined, t0);
		const refund = WagerTransaction.create({
			id: crypto.randomUUID(),
			providerId: "prov-a",
			externalTransactionId: "ext-refund",
			idempotencyKey: "prov-a:ext-refund",
			payloadHash: "hash",
			walletId,
			playerId: "player-1",
			roundId: "round-1",
			gameId: "game-1",
			kind: WagerTransactionKind.Refund,
			money: brl("30.00"),
			referenceExternalTransactionId: "ext-1",
			createdAt: t0,
		});
		refund.markProcessed(bet.id, t1);

		await uow.run(async ({ transactions }) => {
			await transactions.insert(bet, brl("70.00"));
			expect(await transactions.hasProcessedReversal(bet.id)).toBe(false);
			await transactions.insert(refund, brl("100.00"));
			expect(await transactions.hasProcessedReversal(bet.id)).toBe(true);
		});
	});
});

describe("atomicidade da unidade de trabalho", () => {
	test("erro no meio desfaz tudo (rollback)", async () => {
		const walletId = await seedWallet();
		await expect(
			uow.run(async ({ transactions }) => {
				await transactions.insert(newBet(walletId), undefined);
				throw new Error("falha no meio");
			}),
		).rejects.toThrow("falha no meio");
		const found = await uow.run(({ transactions }) =>
			transactions.findByExternalId("prov-a", "ext-1"),
		);
		expect(found).toBeUndefined();
	});
});

describe("lock por wallet (FOR UPDATE)", () => {
	test("com lock, a segunda unidade de trabalho espera o commit e lê o saldo NOVO", async () => {
		const id = await seedWallet("100.00");
		let secondSaw: string | undefined;

		const first = uow.run(async ({ wallets }) => {
			const wallet = await wallets.lockById(id);
			if (wallet === undefined) throw new Error("wallet sumiu");
			await sleep(400);
			wallet.debit({
				money: brl("80.00"),
				entryId: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				at: t1,
			});
			await wallets.save(wallet, 1);
		});

		await sleep(100);
		const second = uow.run(async ({ wallets }) => {
			const wallet = await wallets.lockById(id);
			secondSaw = wallet?.balance.toJSON().amount;
		});

		await Promise.all([first, second]);
		expect(secondSaw).toBe("20.00");
	});

	test("DEMONSTRAÇÃO: sem lock, a segunda leitura enxerga o saldo ANTIGO (lost update)", async () => {
		const id = await seedWallet("100.00");
		let secondSaw: string | undefined;

		const first = uow.run(async ({ wallets }) => {
			const wallet = await wallets.lockById(id);
			if (wallet === undefined) throw new Error("wallet sumiu");
			await sleep(400);
			wallet.debit({
				money: brl("80.00"),
				entryId: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				at: t1,
			});
			await wallets.save(wallet, 1);
		});

		await sleep(100);
		const second = (async () => {
			const rows = await orm.em
				.fork()
				.execute("SELECT balance FROM wallets WHERE id = ?::uuid", [id]);
			secondSaw = (rows[0] as { balance: string }).balance;
		})();

		await Promise.all([first, second]);
		expect(secondSaw).toBe("100.00");
	});
});

describe("SqlOutboxRepository", () => {
	function balanceChanged(walletId: string, note = "ok"): WalletBalanceChanged {
		return new WalletBalanceChanged({
			eventId: crypto.randomUUID(),
			aggregateId: walletId,
			correlationId: `corr-${note}`,
			occurredAt: t0,
			data: {
				walletId,
				transactionId: crypto.randomUUID(),
				direction: LedgerDirection.Debit,
				money: { amount: "30.00", currency: "BRL" },
				balanceBefore: { amount: "100.00", currency: "BRL" },
				balanceAfter: { amount: "70.00", currency: "BRL" },
				walletVersion: 2,
			},
		});
	}

	test("grava o envelope como jsonb, pendente de publicação", async () => {
		const walletId = await seedWallet();
		const event = balanceChanged(walletId, "a?b:c");
		await uow.run(({ outbox }) => outbox.add(event));

		const rows = await orm.em.fork().execute(
			`SELECT aggregate_id, event_type, payload->>'eventType' AS type_in_payload,
              payload->>'correlationId' AS correlation, payload #>> '{data,balanceAfter,amount}' AS after,
              published_at, attempts
         FROM outbox_messages`,
		);
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		expect(row.aggregate_id).toBe(walletId);
		expect(row.event_type).toBe("WalletBalanceChanged");
		expect(row.type_in_payload).toBe("WalletBalanceChanged");
		expect(row.correlation).toBe("corr-a?b:c");
		expect(row.after).toBe("70.00");
		expect(row.published_at).toBeNull();
		expect(row.attempts).toBe(0);
	});

	test("o evento da outbox some junto se a transação falhar (atomicidade)", async () => {
		const walletId = await seedWallet();
		await expect(
			uow.run(async ({ outbox, transactions }) => {
				await transactions.insert(newBet(walletId), undefined);
				await outbox.add(balanceChanged(walletId));
				throw new Error("falha depois do evento");
			}),
		).rejects.toThrow("falha depois do evento");

		const outboxRows = await orm.em
			.fork()
			.execute("SELECT 1 FROM outbox_messages");
		const txRows = await orm.em
			.fork()
			.execute("SELECT 1 FROM wager_transactions");
		expect(outboxRows).toHaveLength(0);
		expect(txRows).toHaveLength(0);
	});
});
