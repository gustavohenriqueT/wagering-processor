import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm, truncateAll } from "./support/test-database";

let orm: MikroORM;

beforeAll(async () => {
	orm = await createTestOrm();
});

afterAll(async () => {
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
});

const uuid = (): string => crypto.randomUUID();

function sql(statement: string, params: unknown[] = []): Promise<unknown[]> {
	return orm.em.fork().execute(statement, params);
}

async function expectRejected(
	operation: Promise<unknown>,
	guarantee: string,
): Promise<void> {
	let message = "";
	try {
		await operation;
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	if (message === "") {
		throw new Error(
			`o banco ACEITOU uma operação que deveria violar: ${guarantee}`,
		);
	}
	expect(message).toContain(guarantee);
}

interface WalletRow {
	id: string;
	playerId: string;
	currency: string;
	balance: string;
	version: number;
}

async function insertWallet(
	overrides: Partial<WalletRow> = {},
): Promise<WalletRow> {
	const wallet: WalletRow = {
		id: uuid(),
		playerId: "player-1",
		currency: "BRL",
		balance: "100.00",
		version: 1,
		...overrides,
	};
	await sql(
		"INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?::uuid, ?, ?, ?::numeric, ?)",
		[
			wallet.id,
			wallet.playerId,
			wallet.currency,
			wallet.balance,
			wallet.version,
		],
	);
	return wallet;
}

interface TxOverrides {
	id?: string;
	providerId?: string;
	externalTransactionId?: string;
	idempotencyKey?: string;
	kind?: string;
	amount?: string;
	status?: string;
	currency?: string;
	referenceExternal?: string | null;
	referenceTransactionId?: string | null;
	failureCode?: string | null;
	processedAt?: string | null;
	pendingAttempts?: number;
}

async function insertTransaction(
	walletId: string,
	overrides: TxOverrides = {},
): Promise<{ id: string; external: string }> {
	const id = overrides.id ?? uuid();
	const kind = overrides.kind ?? "BET";
	const status = overrides.status ?? "PROCESSED";
	const external = overrides.externalTransactionId ?? `ext-${uuid()}`;
	const reversal = kind === "REFUND" || kind === "ROLLBACK";
	const referenceExternal =
		"referenceExternal" in overrides
			? overrides.referenceExternal
			: reversal
				? "ref-x"
				: null;
	const failureCode =
		"failureCode" in overrides
			? overrides.failureCode
			: status === "REJECTED" || status === "FAILED"
				? "INSUFFICIENT_FUNDS"
				: null;
	const processedAt =
		"processedAt" in overrides
			? overrides.processedAt
			: status === "PROCESSED"
				? new Date().toISOString()
				: null;

	await sql(
		`INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, processed_at, pending_attempts)
     VALUES (?::uuid, ?, ?, ?, 'hash', ?::uuid, 'player-1', 'r1', 'g1', ?, ?::numeric, ?, ?, ?::uuid, ?, ?,
             ?::timestamptz, ?)`,
		[
			id,
			overrides.providerId ?? "prov",
			external,
			overrides.idempotencyKey ?? `key-${uuid()}`,
			walletId,
			kind,
			overrides.amount ?? "10.00",
			overrides.currency ?? "BRL",
			referenceExternal ?? null,
			overrides.referenceTransactionId ?? null,
			status,
			failureCode ?? null,
			processedAt ?? null,
			overrides.pendingAttempts ?? 0,
		],
	);
	return { id, external };
}

async function insertLedger(
	walletId: string,
	transactionId: string,
	entry: {
		direction?: string;
		amount?: string;
		before?: string;
		after?: string;
	} = {},
): Promise<string> {
	const id = uuid();
	await sql(
		`INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
     VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::numeric, ?::numeric, ?::numeric)`,
		[
			id,
			walletId,
			transactionId,
			entry.direction ?? "DEBIT",
			entry.amount ?? "30.00",
			entry.before ?? "100.00",
			entry.after ?? "70.00",
		],
	);
	return id;
}

describe("wallets", () => {
	test("saldo negativo é recusado pelo banco", async () => {
		await expectRejected(
			insertWallet({ balance: "-0.01" }),
			"ck_wallets_balance_non_negative",
		);
	});

	test("saldo zero é aceito (a fronteira)", async () => {
		await insertWallet({ balance: "0.00" });
	});

	test("uma wallet por jogador e moeda, mas o mesmo jogador pode ter moedas diferentes", async () => {
		await insertWallet({ playerId: "p1", currency: "BRL" });
		await expectRejected(
			insertWallet({ playerId: "p1", currency: "BRL" }),
			"uq_wallets_player_currency",
		);
		await insertWallet({ playerId: "p1", currency: "USD" });
	});

	test("moeda fora do formato de 3 letras maiúsculas é recusada", async () => {
		await expectRejected(insertWallet({ currency: "brl" }), "check constraint");
		await expectRejected(
			insertWallet({ currency: "BRLL" }),
			"check constraint",
		);
	});

	test("version menor que 1 é recusada", async () => {
		await expectRejected(insertWallet({ version: 0 }), "check constraint");
	});

	test("o saldo não aceita mais de 2 casas decimais de forma silenciosa: é arredondado pelo tipo numeric(19,2)", async () => {
		const wallet = await insertWallet({ balance: "10.005" });
		const rows = (await sql(
			"SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid",
			[wallet.id],
		)) as { balance: string }[];
		expect(rows[0]?.balance).toBe("10.01");
	});
});

describe("wager_transactions", () => {
	test("a transação precisa de uma wallet que exista (chave estrangeira)", async () => {
		await expectRejected(
			insertTransaction(uuid()),
			"wager_transactions_wallet_id_fkey",
		);
	});

	test("(provider, externalTransactionId) é único", async () => {
		const wallet = await insertWallet();
		await insertTransaction(wallet.id, {
			providerId: "prov-a",
			externalTransactionId: "ext-1",
		});
		await expectRejected(
			insertTransaction(wallet.id, {
				providerId: "prov-a",
				externalTransactionId: "ext-1",
			}),
			"uq_tx_provider_external",
		);
		await insertTransaction(wallet.id, {
			providerId: "prov-b",
			externalTransactionId: "ext-1",
		});
	});

	test("(provider, Idempotency-Key) é único", async () => {
		const wallet = await insertWallet();
		await insertTransaction(wallet.id, {
			providerId: "prov-a",
			idempotencyKey: "k1",
		});
		await expectRejected(
			insertTransaction(wallet.id, {
				providerId: "prov-a",
				idempotencyKey: "k1",
			}),
			"uq_tx_idempotency",
		);
		await insertTransaction(wallet.id, {
			providerId: "prov-b",
			idempotencyKey: "k1",
		});
	});

	test("REFUND e ROLLBACK exigem referência; os demais tipos podem ter (WIN referencia a BET)", async () => {
		const wallet = await insertWallet();
		await expectRejected(
			insertTransaction(wallet.id, {
				kind: "REFUND",
				referenceExternal: null,
			}),
			"ck_reference_required",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				kind: "ROLLBACK",
				referenceExternal: null,
			}),
			"ck_reference_required",
		);
		await insertTransaction(wallet.id, { kind: "BET" });
		await insertTransaction(wallet.id, {
			kind: "WIN",
			referenceExternal: "ext-da-bet",
		});
		await insertTransaction(wallet.id, {
			kind: "REFUND",
			referenceExternal: "ext-da-bet",
		});
	});

	test("REJECTED e FAILED exigem failure_code; as demais não podem ter", async () => {
		const wallet = await insertWallet();
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "REJECTED",
				failureCode: null,
			}),
			"ck_failure_code",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "FAILED",
				failureCode: null,
			}),
			"ck_failure_code",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "PROCESSED",
				failureCode: "INSUFFICIENT_FUNDS",
			}),
			"ck_failure_code",
		);
		await insertTransaction(wallet.id, {
			status: "REJECTED",
			failureCode: "INSUFFICIENT_FUNDS",
		});
	});

	test("processed_at existe se, e somente se, a transação está PROCESSED", async () => {
		const wallet = await insertWallet();
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "PROCESSED",
				processedAt: null,
			}),
			"ck_processed_at",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "PENDING",
				processedAt: new Date().toISOString(),
			}),
			"ck_processed_at",
		);
		await insertTransaction(wallet.id, { status: "PENDING" });
	});

	test("tipo, status, valor negativo e tentativas negativas são recusados", async () => {
		const wallet = await insertWallet();
		await expectRejected(
			insertTransaction(wallet.id, { kind: "DEPOSIT" }),
			"check constraint",
		);
		await expectRejected(
			insertTransaction(wallet.id, { status: "DONE", processedAt: null }),
			"check constraint",
		);
		await expectRejected(
			insertTransaction(wallet.id, { amount: "-1.00" }),
			"check constraint",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				status: "PENDING",
				pendingAttempts: -1,
			}),
			"ck_pending_attempts_non_negative",
		);
	});
});

describe("uq_one_processed_reversal (uma reversão efetivada por referência)", () => {
	async function betWithRefund() {
		const wallet = await insertWallet();
		const bet = await insertTransaction(wallet.id, { kind: "BET" });
		const refund = await insertTransaction(wallet.id, {
			kind: "REFUND",
			referenceExternal: bet.external,
			referenceTransactionId: bet.id,
		});
		return { wallet, bet, refund };
	}

	test("um segundo estorno efetivado da mesma BET é recusado, inclusive de outro tipo", async () => {
		const { wallet, bet } = await betWithRefund();
		await expectRejected(
			insertTransaction(wallet.id, {
				kind: "REFUND",
				referenceExternal: bet.external,
				referenceTransactionId: bet.id,
			}),
			"uq_one_processed_reversal",
		);
		await expectRejected(
			insertTransaction(wallet.id, {
				kind: "ROLLBACK",
				referenceExternal: bet.external,
				referenceTransactionId: bet.id,
			}),
			"uq_one_processed_reversal",
		);
	});

	test("tentativas REJECTED não contam: não bloqueiam a reversão correta", async () => {
		const wallet = await insertWallet();
		const bet = await insertTransaction(wallet.id, { kind: "BET" });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await insertTransaction(wallet.id, {
				kind: "REFUND",
				status: "REJECTED",
				failureCode: "AMOUNT_MISMATCH",
				referenceExternal: bet.external,
				referenceTransactionId: bet.id,
			});
		}
		await insertTransaction(wallet.id, {
			kind: "REFUND",
			referenceExternal: bet.external,
			referenceTransactionId: bet.id,
		});
	});

	test("o ROLLBACK do REFUND é permitido: referencia o id do REFUND, não o da BET", async () => {
		const { wallet, refund } = await betWithRefund();
		await insertTransaction(wallet.id, {
			kind: "ROLLBACK",
			referenceExternal: refund.external,
			referenceTransactionId: refund.id,
		});
	});

	test("o índice é parcial: só vale para PROCESSED de REFUND e ROLLBACK", async () => {
		const rows = (await sql(
			"SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_one_processed_reversal'",
		)) as { indexdef: string }[];
		expect(rows).toHaveLength(1);
		const definition = rows[0]?.indexdef ?? "";
		expect(definition).toContain("UNIQUE");
		expect(definition).toContain("PROCESSED");
		expect(definition).toContain("REFUND");
		expect(definition).toContain("ROLLBACK");
	});
});

describe("wallet_ledger_entries (ledger)", () => {
	async function walletWithTransaction() {
		const wallet = await insertWallet();
		const transaction = await insertTransaction(wallet.id);
		return { wallet, transaction };
	}

	test("a aritmética antes ± valor = depois é verificada pelo banco", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		await expectRejected(
			insertLedger(wallet.id, transaction.id, {
				direction: "DEBIT",
				amount: "30.00",
				before: "100.00",
				after: "80.00",
			}),
			"ck_ledger_arithmetic",
		);
		await expectRejected(
			insertLedger(wallet.id, transaction.id, {
				direction: "CREDIT",
				amount: "30.00",
				before: "100.00",
				after: "70.00",
			}),
			"ck_ledger_arithmetic",
		);
		await insertLedger(wallet.id, transaction.id, {
			direction: "DEBIT",
			amount: "30.00",
			before: "100.00",
			after: "70.00",
		});
	});

	test("valor deve ser positivo e os saldos não podem ser negativos", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		await expectRejected(
			insertLedger(wallet.id, transaction.id, {
				direction: "CREDIT",
				amount: "0.00",
				before: "10.00",
				after: "10.00",
			}),
			"check constraint",
		);
		await expectRejected(
			insertLedger(wallet.id, transaction.id, {
				direction: "DEBIT",
				amount: "20.00",
				before: "10.00",
				after: "-10.00",
			}),
			"check constraint",
		);
	});

	test("no máximo um lançamento por wallet e transação", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		await insertLedger(wallet.id, transaction.id);
		await expectRejected(
			insertLedger(wallet.id, transaction.id),
			"uq_ledger_wallet_tx",
		);
	});

	test("o lançamento precisa de uma wallet e de uma transação que existam", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		await expectRejected(
			insertLedger(uuid(), transaction.id),
			"foreign key constraint",
		);
		await expectRejected(
			insertLedger(wallet.id, uuid()),
			"foreign key constraint",
		);
	});

	test("IMUTÁVEL: UPDATE e DELETE são recusados pelo próprio banco", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		const id = await insertLedger(wallet.id, transaction.id);
		await expectRejected(
			sql("UPDATE wallet_ledger_entries SET amount = 1.00 WHERE id = ?::uuid", [
				id,
			]),
			"append-only",
		);
		await expectRejected(
			sql("UPDATE wallet_ledger_entries SET direction = ? WHERE id = ?::uuid", [
				"CREDIT",
				id,
			]),
			"append-only",
		);
		await expectRejected(
			sql("DELETE FROM wallet_ledger_entries WHERE id = ?::uuid", [id]),
			"append-only",
		);
		await expectRejected(
			sql("DELETE FROM wallet_ledger_entries"),
			"append-only",
		);
		const rows = await sql(
			"SELECT 1 FROM wallet_ledger_entries WHERE id = ?::uuid",
			[id],
		);
		expect(rows).toHaveLength(1);
	});

	test("decisão documentada: o trigger não cobre TRUNCATE (os testes precisam limpar as tabelas)", async () => {
		const { wallet, transaction } = await walletWithTransaction();
		await insertLedger(wallet.id, transaction.id);
		await sql("TRUNCATE TABLE wallet_ledger_entries");
		expect(await sql("SELECT 1 FROM wallet_ledger_entries")).toHaveLength(0);
	});

	test("seq cresce sempre (é a ordem do ledger e do cursor da API)", async () => {
		const wallet = await insertWallet();
		const sequences: number[] = [];
		for (let index = 0; index < 3; index += 1) {
			const transaction = await insertTransaction(wallet.id);
			const id = await insertLedger(wallet.id, transaction.id);
			const rows = (await sql(
				"SELECT seq::int AS seq FROM wallet_ledger_entries WHERE id = ?::uuid",
				[id],
			)) as { seq: number }[];
			sequences.push(rows[0]?.seq ?? 0);
		}
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(3);
	});
});

describe("inbox_messages", () => {
	const insertInbox = (consumer: string, messageId: string) =>
		sql(
			"INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)",
			[consumer, messageId, "h"],
		);

	test("(consumerName, messageId) é a chave: a mesma mensagem não entra duas vezes no mesmo consumidor", async () => {
		await insertInbox("consumer-a", "msg-1");
		await expectRejected(
			insertInbox("consumer-a", "msg-1"),
			"inbox_messages_pkey",
		);
		await insertInbox("consumer-b", "msg-1");
	});
});

describe("outbox_messages", () => {
	test("attempts não pode ser negativo", async () => {
		await expectRejected(
			sql(
				"INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, attempts) VALUES (?::uuid, 'w1', 'X', '{}'::jsonb, -1)",
				[uuid()],
			),
			"check constraint",
		);
	});

	test("seq é gerado pelo banco e não pode ser informado", async () => {
		await expectRejected(
			sql(
				"INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, seq) VALUES (?::uuid, 'w1', 'X', '{}'::jsonb, 5)",
				[uuid()],
			),
			"GENERATED ALWAYS",
		);
	});

	test("os índices parciais dos pendentes existem", async () => {
		const rows = (await sql(
			"SELECT indexname FROM pg_indexes WHERE tablename = 'outbox_messages' ORDER BY indexname",
		)) as { indexname: string }[];
		const names = rows.map((row) => row.indexname);
		expect(names).toContain("ix_outbox_pending_seq");
		expect(names).toContain("ix_outbox_pending_aggregate");
	});
});
