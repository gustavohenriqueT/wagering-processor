import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import { PendingReferenceWorker } from "../../src/application/pending-reference-worker";
import {
	ProcessWagerTransaction,
	type ProcessWagerTransactionCommand,
} from "../../src/application/process-wager-transaction";
import { FailureCode } from "../../src/domain/failure-code";
import { Money } from "../../src/domain/money";
import {
	WagerTransactionKind,
	WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { SqlUnitOfWork } from "../../src/infrastructure/database/sql-unit-of-work";
import { Metrics } from "../../src/observability/metrics";
import { createTestOrm, truncateAll } from "./support/test-database";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let orm: MikroORM;
let uow: SqlUnitOfWork;
let createWallet: CreateWallet;

beforeAll(async () => {
	orm = await createTestOrm();
	uow = new SqlUnitOfWork(orm);
	createWallet = new CreateWallet(uow);
});

afterAll(async () => {
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
});

const POLICY = {
	maxAttempts: 3,
	baseDelayMs: 30,
	maxDelayMs: 100,
	ttlMs: 60_000,
};

function setup(policy = POLICY) {
	const useCase = new ProcessWagerTransaction(
		uow,
		() => new Date(),
		() => crypto.randomUUID(),
		policy,
	);
	const metrics = new Metrics();
	const worker = new PendingReferenceWorker(uow, useCase, metrics, undefined, {
		batchSize: 20,
		pollIntervalMs: 20,
	});
	return { useCase, worker, metrics };
}

function command(
	walletId: string,
	external: string,
	kind: WagerTransactionKind,
	extra: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
	return {
		providerId: "prov-a",
		externalTransactionId: external,
		idempotencyKey: `prov-a:${external}`,
		playerId: "player-1",
		walletId,
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: brl("30.00"),
		correlationId: `c-${external}`,
		...extra,
	};
}

async function newWallet(): Promise<string> {
	return (
		await createWallet.execute({
			playerId: "player-1",
			initialBalance: brl("100.00"),
			correlationId: "seed",
		})
	).id;
}

async function one(
	sql: string,
	params: unknown[] = [],
): Promise<Record<string, unknown>> {
	return (await orm.em.fork().execute(sql, params))[0] as Record<
		string,
		unknown
	>;
}

async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
	const row = await one(
		`SELECT w.balance = COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = ?::uuid GROUP BY w.balance`,
		[walletId],
	);
	expect(row.consistent).toBe(true);
}

describe("PendingReferenceWorker", () => {
	test("REFUND chega antes da BET: fica pendente e, quando a BET chega, o worker o resolve", async () => {
		const walletId = await newWallet();
		const { useCase, worker } = setup();

		const refund = await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-1",
			}),
		);
		expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

		await useCase.execute(command(walletId, "bet-1", WagerTransactionKind.Bet));
		await sleep(60);
		const run = await worker.runOnce();

		expect(run.processed).toBe(1);
		const status = await one(
			"SELECT status, reference_transaction_id IS NOT NULL AS linked FROM wager_transactions WHERE external_transaction_id = 'refund-1'",
		);
		expect(status).toEqual({ status: "PROCESSED", linked: true });
		expect(
			(
				await one(
					"SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid",
					[walletId],
				)
			).balance,
		).toBe("100.00");
		const events = await orm.em
			.fork()
			.execute(
				"SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY seq",
				[refund.transactionId],
			);
		expect(
			(events as { event_type: string }[]).map((event) => event.event_type),
		).toEqual([
			"WagerTransactionPendingReference",
			"WalletBalanceChanged",
			"WagerTransactionProcessed",
		]);
		await expectLedgerMatchesBalance(walletId);
	});

	test("a referência nunca chega: backoff com tentativas contadas e, esgotado o limite, REJECTED REFERENCE_NOT_FOUND", async () => {
		const walletId = await newWallet();
		const { useCase, worker } = setup();
		await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-fantasma",
			}),
		);

		const attempts: number[] = [];
		for (let round = 0; round < 6; round += 1) {
			await sleep(120);
			await worker.runOnce();
			attempts.push(
				(
					await one(
						"SELECT pending_attempts::int AS n FROM wager_transactions WHERE external_transaction_id = 'refund-1'",
					)
				).n as number,
			);
			const status = (
				await one(
					"SELECT status FROM wager_transactions WHERE external_transaction_id = 'refund-1'",
				)
			).status;
			if (status === "REJECTED") {
				break;
			}
		}

		const final = await one(
			"SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'refund-1'",
		);
		expect(final).toEqual({
			status: "REJECTED",
			failure_code: FailureCode.ReferenceNotFound,
		});
		expect(attempts.slice(0, 2)).toEqual([1, 2]);
		const rejection = await one(
			"SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'",
		);
		expect(rejection.n).toBe(1);
		expect(
			(
				await one(
					"SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid",
					[walletId],
				)
			).balance,
		).toBe("100.00");
	});

	test("o TTL vence antes do limite de tentativas: rejeita por tempo", async () => {
		const walletId = await newWallet();
		const { useCase, worker } = setup({
			...POLICY,
			maxAttempts: 100,
			ttlMs: 50,
		});
		await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-fantasma",
			}),
		);
		await sleep(120);
		const run = await worker.runOnce();
		expect(run.rejected).toBe(1);
		expect(
			(
				await one(
					"SELECT failure_code FROM wager_transactions WHERE external_transaction_id = 'refund-1'",
				)
			).failure_code,
		).toBe("REFERENCE_NOT_FOUND");
	});

	test("antes do vencimento do agendamento o worker não toca na transação", async () => {
		const walletId = await newWallet();
		const { useCase, worker } = setup({
			...POLICY,
			baseDelayMs: 60_000,
			maxDelayMs: 60_000,
		});
		await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-1",
			}),
		);
		await useCase.execute(command(walletId, "bet-1", WagerTransactionKind.Bet));
		expect(await worker.runOnce()).toMatchObject({
			processed: 0,
			rejected: 0,
			stillPending: 0,
		});
	});

	test("dois workers simultâneos sobre a mesma pendente: resolvida uma única vez", async () => {
		const walletId = await newWallet();
		const { useCase } = setup();
		const first = setup().worker;
		const second = setup().worker;
		await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-1",
			}),
		);
		await useCase.execute(command(walletId, "bet-1", WagerTransactionKind.Bet));
		await sleep(60);

		const [a, b] = await Promise.all([first.runOnce(), second.runOnce()]);
		expect(a.processed + b.processed).toBe(1);
		expect(a.skipped + b.skipped).toBeGreaterThanOrEqual(0);
		expect(
			(
				await one(
					"SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid",
					[walletId],
				)
			).balance,
		).toBe("100.00");
		expect(
			(
				await one(
					"SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'CREDIT'",
				)
			).n,
		).toBe(2);
		await expectLedgerMatchesBalance(walletId);
	});

	test("um segundo estorno pendente da mesma BET é rejeitado como ALREADY_REVERSED", async () => {
		const walletId = await newWallet();
		const { useCase, worker } = setup();
		await useCase.execute(
			command(walletId, "refund-1", WagerTransactionKind.Refund, {
				referenceExternalTransactionId: "bet-1",
			}),
		);
		await useCase.execute(
			command(walletId, "rollback-1", WagerTransactionKind.Rollback, {
				referenceExternalTransactionId: "bet-1",
			}),
		);
		await useCase.execute(command(walletId, "bet-1", WagerTransactionKind.Bet));
		await sleep(60);
		const run = await worker.runOnce();

		expect(run.processed).toBe(1);
		expect(run.rejected).toBe(1);
		const rejected = await one(
			"SELECT failure_code FROM wager_transactions WHERE status = 'REJECTED'",
		);
		expect(rejected.failure_code).toBe("ALREADY_REVERSED");
		await expectLedgerMatchesBalance(walletId);
	});
});
