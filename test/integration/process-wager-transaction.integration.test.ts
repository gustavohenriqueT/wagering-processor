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
import {
	IdempotencyConflictError,
	WalletAlreadyExistsError,
	WalletNotFoundError,
} from "../../src/application/errors";
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

let orm: MikroORM;
let process: ProcessWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
	orm = await createTestOrm();
	const uow = new SqlUnitOfWork(orm);
	process = new ProcessWagerTransaction(uow);
	createWallet = new CreateWallet(uow);
});

afterAll(async () => {
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
});

async function newWallet(
	balance = "100.00",
	playerId = "player-1",
): Promise<string> {
	const wallet = await createWallet.execute({
		playerId,
		initialBalance: brl(balance),
		correlationId: "seed",
	});
	return wallet.id;
}

function command(
	walletId: string,
	external: string,
	kind: WagerTransactionKind,
	amount: string,
	overrides: Partial<ProcessWagerTransactionCommand> = {},
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
		money: brl(amount),
		correlationId: `corr-${external}`,
		...overrides,
	};
}

const bet = (walletId: string, external: string, amount = "30.00") =>
	command(walletId, external, WagerTransactionKind.Bet, amount);

const reversal = (
	walletId: string,
	external: string,
	kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
	referenceExternalId: string,
	amount = "30.00",
) =>
	command(walletId, external, kind, amount, {
		referenceExternalTransactionId: referenceExternalId,
	});

async function balanceOf(walletId: string): Promise<string> {
	const rows = await orm.em
		.fork()
		.execute(
			"SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid",
			[walletId],
		);
	return (rows[0] as { balance: string }).balance;
}

async function versionOf(walletId: string): Promise<number> {
	const rows = await orm.em
		.fork()
		.execute("SELECT version::int AS version FROM wallets WHERE id = ?::uuid", [
			walletId,
		]);
	return (rows[0] as { version: number }).version;
}

async function ledgerOf(
	walletId: string,
): Promise<{ direction: string; amount: string }[]> {
	const rows = await orm.em
		.fork()
		.execute(
			"SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ?::uuid ORDER BY seq",
			[walletId],
		);
	return rows as { direction: string; amount: string }[];
}

async function eventTypes(): Promise<string[]> {
	const rows = await orm.em
		.fork()
		.execute("SELECT event_type FROM outbox_messages ORDER BY event_type");
	return (rows as { event_type: string }[]).map((row) => row.event_type);
}

/** Invariante central: saldo guardado == soma do ledger. */
async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
	const rows = await orm.em.fork().execute(
		`SELECT w.balance = COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ?::uuid GROUP BY w.balance`,
		[walletId],
	);
	expect((rows[0] as { consistent: boolean }).consistent).toBe(true);
}

describe("CreateWallet", () => {
	test("saldo inicial gera transação OPENING + lançamento CREDIT + evento", async () => {
		const id = await newWallet("1000.00");
		expect(await balanceOf(id)).toBe("1000.00");
		expect(await ledgerOf(id)).toEqual([
			{ direction: "CREDIT", amount: "1000.00" },
		]);
		expect(await eventTypes()).toEqual(["WalletBalanceChanged"]);
		await expectLedgerMatchesBalance(id);
	});

	test("saldo inicial zero não gera lançamento", async () => {
		const id = await newWallet("0.00");
		expect(await ledgerOf(id)).toEqual([]);
	});

	test("wallet duplicada (mesmo jogador e moeda) falha como conflito", async () => {
		await newWallet("10.00");
		await expect(newWallet("20.00")).rejects.toBeInstanceOf(
			WalletAlreadyExistsError,
		);
	});
});

describe("regras de negócio", () => {
	test("BET processada: débito, 1 lançamento, version 2 e eventos", async () => {
		const id = await newWallet("100.00");
		const result = await process.execute(bet(id, "b1", "30.00"));

		expect(result.status).toBe(WagerTransactionStatus.Processed);
		expect(result.balance.toJSON().amount).toBe("70.00");
		expect(result.idempotentReplay).toBe(false);
		expect(await balanceOf(id)).toBe("70.00");
		expect(await versionOf(id)).toBe(2);
		expect((await ledgerOf(id)).map((entry) => entry.direction)).toEqual([
			"CREDIT",
			"DEBIT",
		]);
		expect(await eventTypes()).toEqual([
			"WagerTransactionProcessed",
			"WalletBalanceChanged",
			"WalletBalanceChanged",
		]);
		await expectLedgerMatchesBalance(id);
	});

	test("BET sem saldo: REJECTED, saldo intacto, sem ledger e só o evento de rejeição", async () => {
		const id = await newWallet("10.00");
		const result = await process.execute(bet(id, "b1", "30.00"));

		expect(result.status).toBe(WagerTransactionStatus.Rejected);
		expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(await balanceOf(id)).toBe("10.00");
		expect(await ledgerOf(id)).toHaveLength(1); // só a abertura
		expect(await eventTypes()).toEqual([
			"WagerTransactionRejected",
			"WalletBalanceChanged",
		]); // o 2º é o da abertura
		await expectLedgerMatchesBalance(id);
	});

	test("WIN credita; LOSS não move saldo, não gera ledger nem WalletBalanceChanged", async () => {
		const id = await newWallet("100.00");
		await process.execute(command(id, "w1", WagerTransactionKind.Win, "50.00"));
		expect(await balanceOf(id)).toBe("150.00");

		const before = (await eventTypes()).filter(
			(type) => type === "WalletBalanceChanged",
		).length;
		const loss = await process.execute(
			command(id, "l1", WagerTransactionKind.Loss, "0.00"),
		);
		expect(loss.status).toBe(WagerTransactionStatus.Processed);
		expect(await balanceOf(id)).toBe("150.00");
		expect(await ledgerOf(id)).toHaveLength(2);
		expect(
			(await eventTypes()).filter((type) => type === "WalletBalanceChanged")
				.length,
		).toBe(before);
		await expectLedgerMatchesBalance(id);
	});

	test("jogador ou moeda diferentes da wallet viram REJECTED com código próprio", async () => {
		const id = await newWallet("100.00");
		const player = await process.execute({
			...bet(id, "b1"),
			playerId: "outro",
		});
		expect(player.failureCode).toBe(FailureCode.PlayerMismatch);

		const currency = await process.execute({
			...bet(id, "b2"),
			money: Money.from({ amount: "5.00", currency: "USD" }),
		});
		expect(currency.failureCode).toBe(FailureCode.CurrencyMismatch);
		expect(await balanceOf(id)).toBe("100.00");
	});

	test("wallet inexistente lança erro e não persiste nada", async () => {
		await expect(
			process.execute(bet(crypto.randomUUID(), "b1")),
		).rejects.toBeInstanceOf(WalletNotFoundError);
		expect(await eventTypes()).toEqual([]);
	});
});

describe("idempotência", () => {
	test("replay idêntico devolve o resultado original, sem novo débito", async () => {
		const id = await newWallet("100.00");
		const first = await process.execute(bet(id, "b1", "30.00"));
		await process.execute(bet(id, "b2", "10.00")); // o saldo muda depois
		const replay = await process.execute(bet(id, "b1", "30.00"));

		expect(replay.idempotentReplay).toBe(true);
		expect(replay.transactionId).toBe(first.transactionId);
		expect(replay.balance.toJSON().amount).toBe("70.00"); // saldo OBSERVADO na época, não o atual (60.00)
		expect(await balanceOf(id)).toBe("60.00");
		expect(await ledgerOf(id)).toHaveLength(3);
	});

	test("replay de uma transação rejeitada devolve a mesma rejeição", async () => {
		const id = await newWallet("10.00");
		await process.execute(bet(id, "b1", "30.00"));
		const replay = await process.execute(bet(id, "b1", "30.00"));
		expect(replay.status).toBe(WagerTransactionStatus.Rejected);
		expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(replay.idempotentReplay).toBe(true);
	});

	test("mesma Idempotency-Key com payload diferente é conflito, não replay", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		const conflict = process.execute({ ...bet(id, "b1", "31.00") });
		await expect(conflict).rejects.toBeInstanceOf(IdempotencyConflictError);
		await expect(conflict).rejects.toMatchObject({
			reason: "PAYLOAD_MISMATCH",
		});
		expect(await balanceOf(id)).toBe("70.00");
	});

	test("mesmo externalTransactionId com outra Idempotency-Key é conflito", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		const reused = process.execute({
			...bet(id, "b1", "30.00"),
			idempotencyKey: "outra-chave",
		});
		await expect(reused).rejects.toMatchObject({
			reason: "EXTERNAL_ID_REUSED",
		});
	});
});

describe("reversões", () => {
	test("REFUND devolve o valor da BET", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		const refund = await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "b1"),
		);
		expect(refund.status).toBe(WagerTransactionStatus.Processed);
		expect(await balanceOf(id)).toBe("100.00");
		await expectLedgerMatchesBalance(id);
	});

	test("segundo estorno da mesma BET (inclusive de outro tipo) é REJECTED: ALREADY_REVERSED", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "b1"),
		);
		const again = await process.execute(
			reversal(id, "r2", WagerTransactionKind.Refund, "b1"),
		);
		const other = await process.execute(
			reversal(id, "r3", WagerTransactionKind.Rollback, "b1"),
		);
		expect(again.failureCode).toBe(FailureCode.AlreadyReversed);
		expect(other.failureCode).toBe(FailureCode.AlreadyReversed);
		expect(await balanceOf(id)).toBe("100.00");
	});

	test("ROLLBACK do REFUND é permitido (referência diferente) e debita de volta", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "b1"),
		);
		const rollback = await process.execute(
			reversal(id, "rb1", WagerTransactionKind.Rollback, "r1"),
		);
		expect(rollback.status).toBe(WagerTransactionStatus.Processed);
		expect(await balanceOf(id)).toBe("70.00");
		await expectLedgerMatchesBalance(id);
	});

	test("reversão que deixaria saldo negativo é REVERSAL_WOULD_OVERDRAW (código distinto de INSUFFICIENT_FUNDS)", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "b1"),
		); // saldo 100
		await process.execute(bet(id, "b2", "100.00")); // saldo 0
		const rollback = await process.execute(
			reversal(id, "rb1", WagerTransactionKind.Rollback, "r1"),
		);

		expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
		expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
		expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
		expect(await balanceOf(id)).toBe("0.00");
	});

	test("referência inexistente vira PENDING_REFERENCE, sem ledger, com evento próprio", async () => {
		const id = await newWallet("100.00");
		const refund = await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "ainda-nao-chegou"),
		);
		expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
		expect(await balanceOf(id)).toBe("100.00");
		expect(await ledgerOf(id)).toHaveLength(1);
		expect(await eventTypes()).toContain("WagerTransactionPendingReference");
	});

	test("valor diferente da referência é AMOUNT_MISMATCH; REFUND de WIN é INVALID_REFERENCE_KIND", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		await process.execute(command(id, "w1", WagerTransactionKind.Win, "20.00"));
		const wrongAmount = await process.execute(
			reversal(id, "r1", WagerTransactionKind.Refund, "b1", "29.00"),
		);
		const wrongKind = await process.execute(
			reversal(id, "r2", WagerTransactionKind.Refund, "w1", "20.00"),
		);
		expect(wrongAmount.failureCode).toBe(FailureCode.AmountMismatch);
		expect(wrongKind.failureCode).toBe(FailureCode.InvalidReferenceKind);
	});
});

describe("concorrência", () => {
	test("CENÁRIO OBRIGATÓRIO: duas apostas de 80 sobre saldo 100, simultâneas", async () => {
		const id = await newWallet("100.00");
		const results = await Promise.all([
			process.execute(bet(id, "b1", "80.00")),
			process.execute(bet(id, "b2", "80.00")),
		]);

		const processed = results.filter(
			(result) => result.status === WagerTransactionStatus.Processed,
		);
		const rejected = results.filter(
			(result) => result.status === WagerTransactionStatus.Rejected,
		);
		expect(processed).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(await balanceOf(id)).toBe("20.00");
		expect(
			(await ledgerOf(id)).filter((entry) => entry.direction === "DEBIT"),
		).toHaveLength(1);
		await expectLedgerMatchesBalance(id);
	});

	test("50 requisições idênticas em paralelo: um único débito, 49 replays", async () => {
		const id = await newWallet("100.00");
		const results = await Promise.all(
			Array.from({ length: 50 }, () => process.execute(bet(id, "b1", "30.00"))),
		);

		expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
			1,
		);
		expect(results.filter((result) => result.idempotentReplay)).toHaveLength(
			49,
		);
		expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
		expect(await balanceOf(id)).toBe("70.00");
		expect(
			(await ledgerOf(id)).filter((entry) => entry.direction === "DEBIT"),
		).toHaveLength(1);
		await expectLedgerMatchesBalance(id);
	});

	test("30 apostas distintas de 1.00 na mesma wallet: nenhuma se perde", async () => {
		const id = await newWallet("100.00");
		await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				process.execute(bet(id, `b${index}`, "1.00")),
			),
		);
		expect(await balanceOf(id)).toBe("70.00");
		expect(await versionOf(id)).toBe(31); // 1 (abertura) + 30 movimentações
		expect(await ledgerOf(id)).toHaveLength(31);
		await expectLedgerMatchesBalance(id);
	});

	test("o saldo nunca fica negativo: 20 apostas de 10.00 sobre saldo 100 (só 10 passam)", async () => {
		const id = await newWallet("100.00");
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				process.execute(bet(id, `b${index}`, "10.00")),
			),
		);
		expect(
			results.filter(
				(result) => result.status === WagerTransactionStatus.Processed,
			),
		).toHaveLength(10);
		expect(
			results.filter(
				(result) => result.status === WagerTransactionStatus.Rejected,
			),
		).toHaveLength(10);
		expect(await balanceOf(id)).toBe("0.00");
		await expectLedgerMatchesBalance(id);
	});

	test("wallets diferentes em paralelo não interferem entre si", async () => {
		const ids = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				newWallet("100.00", `player-${index}`),
			),
		);
		await Promise.all(
			ids.map((id, index) =>
				process.execute({
					...bet(id, `b${index}`, "40.00"),
					playerId: `player-${index}`,
				}),
			),
		);
		for (const id of ids) {
			expect(await balanceOf(id)).toBe("60.00");
			await expectLedgerMatchesBalance(id);
		}
	});

	test("dois estornos simultâneos da mesma BET: só um é efetivado", async () => {
		const id = await newWallet("100.00");
		await process.execute(bet(id, "b1", "30.00"));
		const results = await Promise.all([
			process.execute(reversal(id, "r1", WagerTransactionKind.Refund, "b1")),
			process.execute(reversal(id, "r2", WagerTransactionKind.Rollback, "b1")),
		]);
		expect(
			results.filter(
				(result) => result.status === WagerTransactionStatus.Processed,
			),
		).toHaveLength(1);
		expect(
			results.filter(
				(result) => result.failureCode === FailureCode.AlreadyReversed,
			),
		).toHaveLength(1);
		expect(await balanceOf(id)).toBe("100.00");
		await expectLedgerMatchesBalance(id);
	});

	test("mesma Idempotency-Key usada em wallets diferentes ao mesmo tempo: sem erro 500", async () => {
		const a = await newWallet("100.00", "player-a");
		const b = await newWallet("100.00", "player-b");
		const settled = await Promise.allSettled([
			process.execute({ ...bet(a, "x1", "10.00"), playerId: "player-a" }),
			process.execute({ ...bet(b, "x1", "10.00"), playerId: "player-b" }),
		]);
		const errors = settled.filter((outcome) => outcome.status === "rejected");
		for (const outcome of errors) {
			expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
				IdempotencyConflictError,
			);
		}
		expect(
			settled.filter((outcome) => outcome.status === "fulfilled").length,
		).toBeGreaterThanOrEqual(1);
	});
});

describe("métricas de lock", () => {
	const sleep = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));

	test("sem contenção: mede a espera, mas não conta conflito", async () => {
		const metrics = new Metrics();
		const uow = new SqlUnitOfWork(orm);
		const measured = new ProcessWagerTransaction(
			uow,
			() => new Date(),
			() => crypto.randomUUID(),
			undefined,
			metrics,
		);
		const id = await newWallet("100.00");
		await measured.execute(bet(id, "b1"));

		expect(metrics.counter("wallet_lock_conflicts_total")).toBe(0);
		expect(metrics.render()).toContain("wallet_lock_wait_seconds_count 1");
	});

	test("com a wallet travada por outra transação: conta o conflito e registra a espera", async () => {
		const metrics = new Metrics();
		const uow = new SqlUnitOfWork(orm);
		const measured = new ProcessWagerTransaction(
			uow,
			() => new Date(),
			() => crypto.randomUUID(),
			undefined,
			metrics,
		);
		const id = await newWallet("100.00");

		const holder = uow.run(async ({ wallets }) => {
			await wallets.lockById(id);
			await sleep(300);
		});
		await sleep(100);
		const result = await measured.execute(bet(id, "b1"));
		await holder;

		expect(result.status).toBe(WagerTransactionStatus.Processed);
		expect(metrics.counter("wallet_lock_conflicts_total")).toBe(1);
		const waitSum = Number(
			/wallet_lock_wait_seconds_sum (\S+)/.exec(metrics.render())?.[1],
		);
		expect(waitSum).toBeGreaterThan(0.15);
	});

	test("disputa real: 20 apostas simultâneas na mesma wallet geram conflitos, e o resultado continua correto", async () => {
		const metrics = new Metrics();
		const uow = new SqlUnitOfWork(orm);
		const measured = new ProcessWagerTransaction(
			uow,
			() => new Date(),
			() => crypto.randomUUID(),
			undefined,
			metrics,
		);
		const id = await newWallet("1000.00");
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				measured.execute(bet(id, `b${index}`, "1.00")),
			),
		);

		expect(metrics.counter("wallet_lock_conflicts_total")).toBeGreaterThan(0);
		expect(metrics.render()).toContain("wallet_lock_wait_seconds_count 20");
		expect(await balanceOf(id)).toBe("980.00");
		await expectLedgerMatchesBalance(id);
	});
});
