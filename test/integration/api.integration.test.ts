import "reflect-metadata";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { JsonLogger } from "../../src/observability/logger";
import {
	createTestOrm,
	TEST_DATABASE,
	truncateAll,
} from "./support/test-database";

let app: INestApplication;
let orm: MikroORM;
let baseUrl: string;
const logLines: string[] = [];

beforeAll(async () => {
	orm = await createTestOrm();
	app = await NestFactory.create(
		AppModule.forRoot({ ...config, dbName: TEST_DATABASE }, undefined, {
			logger: new JsonLogger("http", (line) => logLines.push(line)),
		}),
		{ logger: false },
	);
	await app.listen(0);
	baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
	await app?.close();
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
	logLines.length = 0;
});

interface ApiResult {
	status: number;
	// biome-ignore lint/suspicious/noExplicitAny: corpo JSON de resposta, navegado livremente pelos testes
	body: any;
	headers: Headers;
}

async function call(
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<ApiResult> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body === undefined
			? {}
			: { body: typeof body === "string" ? body : JSON.stringify(body) }),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {}
	return { status: response.status, body: parsed, headers: response.headers };
}

function counter(metricsText: string, series: string): number {
	const line = metricsText
		.split("\n")
		.find((candidate) => candidate.startsWith(`${series} `));
	return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

async function createWallet(
	balance = "1000.00",
	playerId = "player-1",
): Promise<{ id: string; playerId: string }> {
	const { status, body } = await call("POST", "/wallets", {
		playerId,
		initialBalance: { amount: balance, currency: "BRL" },
	});
	expect(status).toBe(201);
	return body;
}

function txBody(
	walletId: string,
	external: string,
	kind = "BET",
	amount = "25.00",
	extra: Record<string, unknown> = {},
) {
	return {
		providerId: "provider-a",
		externalTransactionId: external,
		playerId: "player-1",
		walletId,
		roundId: "round-1",
		gameId: "fortune-chimp",
		kind,
		money: { amount, currency: "BRL" },
		...extra,
	};
}

const submit = (body: unknown, key?: string) =>
	call(
		"POST",
		"/wagering/transactions",
		body,
		key === undefined ? {} : { "idempotency-key": key },
	);

describe("health", () => {
	test("live e ready respondem 200, sem autenticação", async () => {
		expect((await call("GET", "/health/live")).body).toEqual({
			status: "ok",
		});
		const ready = await call("GET", "/health/ready");
		expect(ready.status).toBe(200);
		expect(ready.body).toEqual({
			status: "ok",
			checks: { postgres: "up" },
		});
	});
});

describe("POST /wallets", () => {
	test("cria a wallet com o formato do contrato", async () => {
		const { status, body } = await call("POST", "/wallets", {
			playerId: "player-1",
			initialBalance: { amount: "1000.00", currency: "BRL" },
		});
		expect(status).toBe(201);
		expect(body).toEqual({
			id: expect.any(String),
			playerId: "player-1",
			balance: { amount: "1000.00", currency: "BRL" },
			version: 1,
		});
	});

	test("wallet duplicada para o mesmo jogador e moeda é 409", async () => {
		await createWallet();
		const { status, body } = await call("POST", "/wallets", {
			playerId: "player-1",
			initialBalance: { amount: "5.00", currency: "BRL" },
		});
		expect(status).toBe(409);
		expect(body.error.code).toBe("WALLET_ALREADY_EXISTS");
	});

	test("payload inválido é 400 com detalhes por campo", async () => {
		const { status, body } = await call("POST", "/wallets", {
			initialBalance: { amount: "1.5", currency: "BRL" },
		});
		expect(status).toBe(400);
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(body.error.retriable).toBe(false);
		expect(
			body.error.details.map((issue: { field: string }) => issue.field).sort(),
		).toEqual(["initialBalance", "playerId"]);
	});

	test("JSON malformado é 400, não 500", async () => {
		const { status, body } = await call("POST", "/wallets", "{ não é json");
		expect(status).toBe(400);
		expect(body.error.code).toBe("INVALID_REQUEST");
	});
});

describe("consultas", () => {
	test("GET /wallets/:id, 404 e UUID inválido", async () => {
		const wallet = await createWallet();
		expect(
			(await call("GET", `/wallets/${wallet.id}`)).body.balance.amount,
		).toBe("1000.00");
		expect((await call("GET", `/wallets/${crypto.randomUUID()}`)).status).toBe(
			404,
		);
		expect((await call("GET", "/wallets/nao-e-uuid")).status).toBe(400);
	});

	test("rota inexistente devolve o mesmo formato de erro", async () => {
		const { status, body } = await call("GET", "/nao-existe");
		expect(status).toBe(404);
		expect(body.error.code).toBe("NOT_FOUND");
	});

	test("transação por id e por provedor + externalTransactionId", async () => {
		const wallet = await createWallet();
		const created = await submit(txBody(wallet.id, "tx-1"), "provider-a:tx-1");
		const byId = await call(
			"GET",
			`/wagering/transactions/${created.body.transactionId}`,
		);
		const byExternal = await call(
			"GET",
			"/providers/provider-a/wagering/transactions/tx-1",
		);
		expect(byId.status).toBe(200);
		expect(byId.body).toMatchObject({
			status: "PROCESSED",
			kind: "BET",
			balance: { amount: "975.00", currency: "BRL" },
		});
		expect(byExternal.body.transactionId).toBe(created.body.transactionId);
		expect(
			(await call("GET", `/wagering/transactions/${crypto.randomUUID()}`))
				.status,
		).toBe(404);
		expect(
			(await call("GET", "/providers/provider-a/wagering/transactions/nada"))
				.status,
		).toBe(404);
	});
});

describe("POST /wagering/transactions", () => {
	test("BET processada: 200 e o formato do contrato", async () => {
		const wallet = await createWallet();
		const { status, body, headers } = await submit(
			txBody(wallet.id, "tx-1"),
			"provider-a:tx-1",
		);
		expect(status).toBe(200);
		expect(body).toEqual({
			transactionId: expect.any(String),
			status: "PROCESSED",
			balance: { amount: "975.00", currency: "BRL" },
			idempotentReplay: false,
		});
		expect(headers.get("x-correlation-id")).toBeTruthy();
	});

	test("o X-Correlation-Id enviado é devolvido", async () => {
		const wallet = await createWallet();
		const { headers } = await call(
			"POST",
			"/wagering/transactions",
			txBody(wallet.id, "tx-1"),
			{
				"idempotency-key": "k1",
				"x-correlation-id": "minha-correlacao",
			},
		);
		expect(headers.get("x-correlation-id")).toBe("minha-correlacao");
	});

	test("repetir a requisição: mesma resposta com idempotentReplay true", async () => {
		const wallet = await createWallet();
		const first = await submit(txBody(wallet.id, "tx-1"), "provider-a:tx-1");
		const replay = await submit(txBody(wallet.id, "tx-1"), "provider-a:tx-1");
		expect(replay.status).toBe(200);
		expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
	});

	test("mesma key com payload diferente é 409 (não replay)", async () => {
		const wallet = await createWallet();
		await submit(txBody(wallet.id, "tx-1"), "provider-a:tx-1");
		const { status, body } = await submit(
			txBody(wallet.id, "tx-1", "BET", "26.00"),
			"provider-a:tx-1",
		);
		expect(status).toBe(409);
		expect(body.error).toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
			retriable: false,
			details: { reason: "PAYLOAD_MISMATCH" },
		});
	});

	test("sem Idempotency-Key é 400", async () => {
		const wallet = await createWallet();
		const { status, body } = await submit(txBody(wallet.id, "tx-1"));
		expect(status).toBe(400);
		expect(body.error.details[0].field).toBe("Idempotency-Key");
	});

	test("OPENING e REFUND sem referência são 400", async () => {
		const wallet = await createWallet();
		expect((await submit(txBody(wallet.id, "a", "OPENING"), "k1")).status).toBe(
			400,
		);
		expect((await submit(txBody(wallet.id, "b", "REFUND"), "k2")).status).toBe(
			400,
		);
	});

	test("rejeição de negócio é 422 com failureCode, e o replay também", async () => {
		const wallet = await createWallet("10.00");
		const first = await submit(txBody(wallet.id, "tx-1", "BET", "30.00"), "k1");
		expect(first.status).toBe(422);
		expect(first.body).toMatchObject({
			status: "REJECTED",
			failureCode: "INSUFFICIENT_FUNDS",
			idempotentReplay: false,
		});
		const replay = await submit(
			txBody(wallet.id, "tx-1", "BET", "30.00"),
			"k1",
		);
		expect(replay.status).toBe(422);
		expect(replay.body.idempotentReplay).toBe(true);
	});

	test("referência ainda inexistente é 202 (aceito, pendente)", async () => {
		const wallet = await createWallet();
		const { status, body } = await submit(
			txBody(wallet.id, "r1", "REFUND", "25.00", {
				referenceExternalTransactionId: "ainda-nao-chegou",
			}),
			"k1",
		);
		expect(status).toBe(202);
		expect(body.status).toBe("PENDING_REFERENCE");
	});

	test("wallet inexistente é 404", async () => {
		const { status, body } = await submit(
			txBody(crypto.randomUUID(), "tx-1"),
			"k1",
		);
		expect(status).toBe(404);
		expect(body.error.code).toBe("WALLET_NOT_FOUND");
	});

	test("CENÁRIO OBRIGATÓRIO por HTTP: duas apostas de 80 sobre saldo 100", async () => {
		const wallet = await createWallet("100.00");
		const results = await Promise.all([
			submit(txBody(wallet.id, "a", "BET", "80.00"), "ka"),
			submit(txBody(wallet.id, "b", "BET", "80.00"), "kb"),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
		expect(
			(await call("GET", `/wallets/${wallet.id}`)).body.balance.amount,
		).toBe("20.00");
		const ledger = await call("GET", `/wallets/${wallet.id}/ledger`);
		expect(
			ledger.body.entries.filter(
				(entry: { direction: string }) => entry.direction === "DEBIT",
			),
		).toHaveLength(1);
	});
});

describe("GET /wallets/:id/ledger", () => {
	test("paginação por cursor opaco: percorre tudo, sem repetir nem pular", async () => {
		const wallet = await createWallet("1000.00");
		for (let index = 0; index < 5; index += 1) {
			await submit(
				txBody(wallet.id, `tx-${index}`, "BET", "10.00"),
				`k${index}`,
			);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const query = `?limit=2${cursor === undefined ? "" : `&cursor=${cursor}`}`;
			const { status, body } = await call(
				"GET",
				`/wallets/${wallet.id}/ledger${query}`,
			);
			expect(status).toBe(200);
			seen.push(...body.entries.map((entry: { id: string }) => entry.id));
			cursor = body.nextCursor;
			pages += 1;
		} while (cursor !== undefined);

		expect(seen).toHaveLength(6);
		expect(new Set(seen).size).toBe(6);
		expect(pages).toBe(3);
	});

	test("entradas vêm em ordem cronológica e com saldo antes e depois", async () => {
		const wallet = await createWallet("100.00");
		await submit(txBody(wallet.id, "tx-1", "BET", "30.00"), "k1");
		const { body } = await call("GET", `/wallets/${wallet.id}/ledger`);
		expect(
			body.entries.map((entry: { direction: string }) => entry.direction),
		).toEqual(["CREDIT", "DEBIT"]);
		expect(body.entries[1]).toMatchObject({
			money: { amount: "30.00", currency: "BRL" },
			balanceBefore: { amount: "100.00", currency: "BRL" },
			balanceAfter: { amount: "70.00", currency: "BRL" },
		});
		expect(body.nextCursor).toBeUndefined();
	});

	test("cursor inválido, limit fora da faixa e wallet inexistente", async () => {
		const wallet = await createWallet();
		expect(
			(await call("GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status,
		).toBe(400);
		expect(
			(await call("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status,
		).toBe(400);
		expect(
			(await call("GET", `/wallets/${wallet.id}/ledger?limit=201`)).status,
		).toBe(400);
		expect(
			(await call("GET", `/wallets/${crypto.randomUUID()}/ledger`)).status,
		).toBe(404);
	});
});

describe("reconciliação", () => {
	test("wallet íntegra: consistent true e diferença zero", async () => {
		const wallet = await createWallet("100.00");
		await submit(txBody(wallet.id, "tx-1", "BET", "30.00"), "k1");
		const { status, body } = await call(
			"POST",
			`/wallets/${wallet.id}/reconciliation`,
		);
		expect(status).toBe(200);
		expect(body).toEqual({
			walletId: wallet.id,
			storedBalance: { amount: "70.00", currency: "BRL" },
			calculatedBalance: { amount: "70.00", currency: "BRL" },
			difference: { amount: "0.00", currency: "BRL" },
			consistent: true,
			checkedEntries: 2,
		});
	});

	test("divergência: é sinalizada, contada em métrica e NÃO é corrigida", async () => {
		const before = (await call("GET", "/metrics")).body as string;
		const wallet = await createWallet("100.00");
		await orm.em
			.fork()
			.execute("UPDATE wallets SET balance = 999.00 WHERE id = ?::uuid", [
				wallet.id,
			]);

		const { body } = await call("POST", `/wallets/${wallet.id}/reconciliation`);
		expect(body.consistent).toBe(false);
		expect(body.storedBalance.amount).toBe("999.00");
		expect(body.calculatedBalance.amount).toBe("100.00");
		expect(body.difference.amount).toBe("899.00");

		expect(
			(await call("GET", `/wallets/${wallet.id}`)).body.balance.amount,
		).toBe("999.00");
		const after = (await call("GET", "/metrics")).body as string;
		expect(
			counter(after, "reconciliation_divergences_total") -
				counter(before, "reconciliation_divergences_total"),
		).toBe(1);
	});
});

describe("métricas", () => {
	test("/metrics expõe contadores de transações e de erros (compara o aumento, pois o contador é cumulativo)", async () => {
		const rejected =
			'wager_transactions_total{kind="BET",replay="false",status="REJECTED"}';
		const validation =
			'http_errors_total{code="VALIDATION_ERROR",status="400"}';
		const before = (await call("GET", "/metrics")).body as string;

		const wallet = await createWallet("10.00");
		await submit(txBody(wallet.id, "tx-1", "BET", "30.00"), "k1");
		await call("GET", "/wallets/nao-e-uuid");

		const after = (await call("GET", "/metrics")).body as string;
		expect(counter(after, rejected) - counter(before, rejected)).toBe(1);
		expect(counter(after, validation) - counter(before, validation)).toBe(1);
	});
});

describe("observabilidade HTTP", () => {
	const logsOf = (event: string): Record<string, unknown>[] =>
		logLines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.event === event);

	test("toda resposta tem X-Correlation-Id, inclusive em rota inexistente; o enviado é respeitado", async () => {
		const live = await call("GET", "/health/live");
		const missing = await call("GET", "/nao-existe");
		const echoed = await call("GET", "/health/live", undefined, {
			"x-correlation-id": "minha-id",
		});
		expect(live.headers.get("x-correlation-id")).toBeTruthy();
		expect(missing.headers.get("x-correlation-id")).toBeTruthy();
		expect(echoed.headers.get("x-correlation-id")).toBe("minha-id");
	});

	test("o histograma de latência e o contador de requisições usam o padrão da rota, não o caminho concreto", async () => {
		const wallet = await createWallet();
		const ok =
			'http_requests_total{method="POST",route="/wagering/transactions",status="200"}';
		const notFound =
			'http_requests_total{method="GET",route="unmatched",status="404"}';
		const before = (await call("GET", "/metrics")).body as string;

		await submit(txBody(wallet.id, "tx-1"), "k1");
		await call("GET", `/wallets/${wallet.id}`);
		await call("GET", "/rota/que/nao/existe");

		const after = (await call("GET", "/metrics")).body as string;
		expect(counter(after, ok) - counter(before, ok)).toBe(1);
		expect(counter(after, notFound) - counter(before, notFound)).toBe(1);
		expect(after).toContain(
			'http_requests_total{method="GET",route="/wallets/:walletId",status="200"}',
		);
		expect(after).not.toContain(wallet.id);
		expect(after).toContain(
			'http_request_duration_seconds_bucket{le="+Inf",method="POST",route="/wagering/transactions",status="200"}',
		);
		expect(after).toContain(
			'http_request_duration_seconds_count{method="POST",route="/wagering/transactions",status="200"}',
		);
	});

	test("uma linha de log JSON por requisição, com correlação e latência, sem corpo nem valores", async () => {
		const wallet = await createWallet();
		logLines.length = 0;
		await call(
			"POST",
			"/wagering/transactions",
			txBody(wallet.id, "tx-1", "BET", "25.00"),
			{
				"idempotency-key": "k1",
				"x-correlation-id": "corr-log-1",
			},
		);

		const requests = logsOf("http_request");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			level: "info",
			component: "http",
			correlationId: "corr-log-1",
			method: "POST",
			path: "/wagering/transactions",
			route: "/wagering/transactions",
			status: 200,
		});
		expect(typeof requests[0]?.durationMs).toBe("number");
		const raw = logLines.join("\n");
		expect(raw).not.toContain("25.00");
		expect(raw).not.toContain("fortune-chimp");
	});

	test("o nível do log acompanha o status (4xx = warn), e health e metrics não geram linha de log", async () => {
		await call("GET", "/health/live");
		await call("GET", "/health/ready");
		await call("GET", "/metrics");
		expect(logsOf("http_request")).toHaveLength(0);

		await call("GET", "/wallets/nao-e-uuid");
		const [entry] = logsOf("http_request");
		expect(entry).toMatchObject({ level: "warn", status: 400 });
	});

	test("a divergência de reconciliação sai como log JSON de alerta, com a diferença", async () => {
		const wallet = await createWallet("100.00");
		await orm.em
			.fork()
			.execute("UPDATE wallets SET balance = 999.00 WHERE id = ?::uuid", [
				wallet.id,
			]);
		logLines.length = 0;
		await call("POST", `/wallets/${wallet.id}/reconciliation`);

		const [alert] = logsOf("reconciliation_divergence");
		expect(alert).toMatchObject({
			level: "warn",
			walletId: wallet.id,
			difference: "899.00",
			currency: "BRL",
		});
	});
});
