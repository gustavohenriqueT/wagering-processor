import { describe, expect, test } from "bun:test";
import { ValidationError } from "./errors";
import {
	decodeCursor,
	encodeCursor,
	parseLimit,
	parseSubmitTransaction,
	parseUuid,
} from "./parsers";

const validBody = {
	providerId: "prov-a",
	externalTransactionId: "ext-1",
	playerId: "player-1",
	walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
	roundId: "round-1",
	gameId: "game-1",
	kind: "BET",
	money: { amount: "25.00", currency: "BRL" },
};

function issuesOf(fn: () => unknown): string[] {
	try {
		fn();
	} catch (error) {
		if (error instanceof ValidationError) {
			return error.issues.map((issue) => issue.field);
		}
		throw error;
	}
	return [];
}

describe("parseSubmitTransaction", () => {
	test("aceita um payload válido e normaliza para o comando", () => {
		const command = parseSubmitTransaction(validBody, "prov-a:ext-1", "corr-1");
		expect(command.idempotencyKey).toBe("prov-a:ext-1");
		expect(command.money.toJSON().amount).toBe("25.00");
		expect(command.correlationId).toBe("corr-1");
	});

	test("exige o header Idempotency-Key", () => {
		expect(
			issuesOf(() => parseSubmitTransaction(validBody, undefined, "c")),
		).toContain("Idempotency-Key");
		expect(
			issuesOf(() => parseSubmitTransaction(validBody, "   ", "c")),
		).toContain("Idempotency-Key");
	});

	test("reporta TODOS os campos inválidos de uma vez", () => {
		const fields = issuesOf(() =>
			parseSubmitTransaction(
				{ kind: "X", money: 5, walletId: "abc" },
				"k",
				"c",
			),
		);
		expect(fields).toEqual(
			expect.arrayContaining([
				"providerId",
				"externalTransactionId",
				"walletId",
				"kind",
				"money",
			]),
		);
	});

	test("OPENING não pode ser submetido", () => {
		expect(
			issuesOf(() =>
				parseSubmitTransaction({ ...validBody, kind: "OPENING" }, "k", "c"),
			),
		).toContain("kind");
	});

	test("REFUND e ROLLBACK exigem referência", () => {
		expect(
			issuesOf(() =>
				parseSubmitTransaction({ ...validBody, kind: "REFUND" }, "k", "c"),
			),
		).toContain("referenceExternalTransactionId");
	});

	test("BET com valor zero é inválida, LOSS com zero é válida", () => {
		const zero = { amount: "0.00", currency: "BRL" };
		expect(
			issuesOf(() =>
				parseSubmitTransaction({ ...validBody, money: zero }, "k", "c"),
			),
		).toContain("money");
		expect(
			issuesOf(() =>
				parseSubmitTransaction(
					{ ...validBody, kind: "LOSS", money: zero },
					"k",
					"c",
				),
			),
		).toEqual([]);
	});

	test("valor monetário fora do contrato (número, 1 casa) é inválido", () => {
		expect(
			issuesOf(() =>
				parseSubmitTransaction(
					{ ...validBody, money: { amount: 25, currency: "BRL" } },
					"k",
					"c",
				),
			),
		).toContain("money");
		expect(
			issuesOf(() =>
				parseSubmitTransaction(
					{
						...validBody,
						money: { amount: "25.5", currency: "BRL" },
					},
					"k",
					"c",
				),
			),
		).toContain("money");
	});

	test("corpo que não é objeto é inválido", () => {
		expect(issuesOf(() => parseSubmitTransaction([], "k", "c"))).toEqual([
			"body",
		]);
		expect(issuesOf(() => parseSubmitTransaction(null, "k", "c"))).toEqual([
			"body",
		]);
	});
});

describe("parâmetros", () => {
	test("parseUuid", () => {
		expect(
			parseUuid("0192f291-27dd-7d3f-8071-5f8685deef37", "id"),
		).toBeString();
		expect(issuesOf(() => parseUuid("nao-e-uuid", "id"))).toEqual(["id"]);
	});

	test("cursor é opaco: ida e volta, e rejeita lixo", () => {
		expect(decodeCursor(encodeCursor("42"))).toBe("42");
		expect(decodeCursor(undefined)).toBeUndefined();
		expect(issuesOf(() => decodeCursor("lixo"))).toEqual(["cursor"]);
		expect(
			issuesOf(() =>
				decodeCursor(
					Buffer.from('{"s":"1; DROP TABLE x"}').toString("base64url"),
				),
			),
		).toEqual(["cursor"]);
	});

	test("limit: padrão 50, entre 1 e 200", () => {
		expect(parseLimit(undefined)).toBe(50);
		expect(parseLimit("200")).toBe(200);
		for (const bad of ["0", "201", "-1", "1.5", "abc"]) {
			expect(issuesOf(() => parseLimit(bad))).toEqual(["limit"]);
		}
	});
});
