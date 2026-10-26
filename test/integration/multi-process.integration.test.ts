import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { join } from "node:path";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/create-wallet";
import { Money } from "../../src/domain/money";
import { SqlUnitOfWork } from "../../src/infrastructure/database/sql-unit-of-work";
import type { QueueUrls } from "../../src/messaging/queues";
import {
	createTestOrm,
	TEST_DATABASE,
	truncateAll,
} from "./support/test-database";
import {
	createSqsClient,
	createTestQueues,
	drain,
	waitFor,
} from "./support/test-sqs";

setDefaultTimeout(120_000);

const WORKER_SCRIPT = join(import.meta.dir, "support", "worker-process.ts");
const WALLETS = 4;
const MESSAGES_PER_WALLET = 15;
const TOTAL = WALLETS * MESSAGES_PER_WALLET;

let orm: MikroORM;
let sqs: SQSClient;
let urls: QueueUrls;
let createWallet: CreateWallet;
const running: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
	orm = await createTestOrm();
	sqs = createSqsClient();
	urls = await createTestQueues(sqs);
	createWallet = new CreateWallet(new SqlUnitOfWork(orm));
	await orm.em.execute(
		"CREATE TABLE IF NOT EXISTS test_worker_marks (worker_id text NOT NULL, message_id text NOT NULL)",
	);
});

afterAll(async () => {
	await orm?.em.execute("DROP TABLE IF EXISTS test_worker_marks");
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
	await orm.em.execute("TRUNCATE TABLE test_worker_marks");
	await drain(sqs, urls.transactions, 1);
	await drain(sqs, urls.transactionsDlq, 1);
});

afterEach(async () => {
	for (const worker of running.splice(0)) {
		worker.kill();
		await worker.exited;
	}
});

function spawnWorker(workerId: string): ReturnType<typeof Bun.spawn> {
	const worker = Bun.spawn([process.execPath, WORKER_SCRIPT], {
		env: {
			...process.env,
			WORKER_ID: workerId,
			WORKER_DB_NAME: TEST_DATABASE,
			WORKER_QUEUE_URL: urls.transactions,
			WORKER_DLQ_URL: urls.transactionsDlq,
			WORKER_DELAY_MS: "60",
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	running.push(worker);
	return worker;
}

async function waitForWorkersReady(count: number): Promise<void> {
	await waitFor(
		async () =>
			(
				await one(
					"SELECT count(*)::int AS n FROM test_worker_marks WHERE message_id = '__ready__'",
				)
			).n === count,
		{ timeoutMs: 60_000, intervalMs: 200 },
	);
}

async function seedWorkload(): Promise<string[]> {
	const wallets: string[] = [];
	for (let index = 0; index < WALLETS; index += 1) {
		const wallet = await createWallet.execute({
			playerId: `player-${index}`,
			initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
			correlationId: "seed",
		});
		wallets.push(wallet.id);
	}
	const run = crypto.randomUUID().slice(0, 8);
	for (let message = 0; message < MESSAGES_PER_WALLET; message += 1) {
		for (const [index, walletId] of wallets.entries()) {
			const messageId = `m-${run}-${index}-${message}`;
			await sqs.send(
				new SendMessageCommand({
					QueueUrl: urls.transactions,
					MessageGroupId: walletId,
					MessageDeduplicationId: messageId,
					MessageBody: JSON.stringify({
						messageId,
						type: "WagerTransactionRequested",
						occurredAt: new Date().toISOString(),
						data: {
							providerId: "prov-a",
							externalTransactionId: `ext-${messageId}`,
							idempotencyKey: `prov-a:ext-${messageId}`,
							playerId: `player-${index}`,
							walletId,
							roundId: "round-1",
							gameId: "game-1",
							kind: "BET",
							money: { amount: "2.00", currency: "BRL" },
						},
					}),
				}),
			);
		}
	}
	return wallets;
}

async function one(
	statement: string,
	params: unknown[] = [],
): Promise<Record<string, unknown>> {
	return (
		(
			(await orm.em.fork().execute(statement, params)) as Record<
				string,
				unknown
			>[]
		)[0] ?? {}
	);
}

const processedCount = async (): Promise<number> =>
	(await one("SELECT count(*)::int AS n FROM inbox_messages")).n as number;

async function expectExactlyOnceEffects(wallets: string[]): Promise<void> {
	expect(await processedCount()).toBe(TOTAL);
	expect(
		(
			await one(
				"SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'",
			)
		).n,
	).toBe(TOTAL);
	expect(
		(
			await one(
				"SELECT count(DISTINCT message_id)::int AS n FROM test_worker_marks WHERE message_id <> '__ready__'",
			)
		).n,
	).toBe(TOTAL);
	for (const walletId of wallets) {
		const row = await one(
			`SELECT w.balance::text AS balance,
              w.balance = COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?::uuid GROUP BY w.balance`,
			[walletId],
		);
		expect(row.balance).toBe("70.00");
		expect(row.consistent).toBe(true);
	}
	expect(await drain(sqs, urls.transactionsDlq, 1)).toHaveLength(0);
}

describe("múltiplos PROCESSOS de verdade sobre o mesmo banco e a mesma fila", () => {
	test("3 processos consomem em paralelo: cada mensagem tem efeito único e o trabalho é dividido", async () => {
		const workers = [spawnWorker("w1"), spawnWorker("w2"), spawnWorker("w3")];
		await waitForWorkersReady(3);
		const wallets = await seedWorkload();

		await waitFor(async () => (await processedCount()) === TOTAL, {
			timeoutMs: 90_000,
			intervalMs: 250,
		});

		expect(workers.every((worker) => worker.exitCode === null)).toBe(true);
		await expectExactlyOnceEffects(wallets);
		const distribution = (await orm.em
			.fork()
			.execute(
				"SELECT worker_id, count(*)::int AS n FROM test_worker_marks WHERE message_id <> '__ready__' GROUP BY worker_id",
			)) as { worker_id: string; n: number }[];
		expect(distribution.length).toBeGreaterThanOrEqual(2);
	});

	test("um processo é morto com SIGKILL no meio do trabalho, outro o substitui, e nada se perde nem duplica", async () => {
		const victim = spawnWorker("w1");
		spawnWorker("w2");
		spawnWorker("w3");
		await waitForWorkersReady(3);
		const wallets = await seedWorkload();

		await waitFor(async () => (await processedCount()) >= 10, {
			timeoutMs: 60_000,
			intervalMs: 100,
		});
		victim.kill("SIGKILL");
		await victim.exited;
		expect(await processedCount()).toBeLessThan(TOTAL);
		spawnWorker("w4");

		await waitFor(async () => (await processedCount()) === TOTAL, {
			timeoutMs: 90_000,
			intervalMs: 250,
		});
		await expectExactlyOnceEffects(wallets);
	});
});
