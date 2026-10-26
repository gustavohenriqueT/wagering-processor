import { describe, expect, test } from "bun:test";
import { NotFoundException } from "@nestjs/common";
import {
	IdempotencyConflictError,
	WalletAlreadyExistsError,
	WalletNotFoundError,
} from "../application/errors";
import { DomainError } from "../domain/errors/domain-error";
import { InvalidTransactionStateError } from "../domain/errors/invalid-transaction-state-error";
import { isTransientInfrastructureError, mapError } from "./error-mapping";
import { ValidationError } from "./errors";

describe("mapError: as cinco situações que o provedor precisa distinguir", () => {
	test("payload inválido -> 400, não retriable, com detalhes por campo", () => {
		const mapped = mapError(
			new ValidationError([{ field: "kind", message: "inválido" }]),
		);
		expect(mapped.status).toBe(400);
		expect(mapped.code).toBe("VALIDATION_ERROR");
		expect(mapped.retriable).toBe(false);
		expect(mapped.details).toEqual([{ field: "kind", message: "inválido" }]);
	});

	test("erros de entrada detectados pelo domínio também são 400", () => {
		for (const code of [
			"INVALID_MONEY_AMOUNT",
			"INVALID_CURRENCY",
			"INVALID_AMOUNT",
			"REFERENCE_REQUIRED",
		]) {
			expect(mapError(new DomainError(code, "x")).status).toBe(400);
		}
	});

	test("conflito de idempotência -> 409 com a razão", () => {
		const mapped = mapError(
			new IdempotencyConflictError("PAYLOAD_MISMATCH", "x"),
		);
		expect(mapped.status).toBe(409);
		expect(mapped.retriable).toBe(false);
		expect(mapped.details).toEqual({ reason: "PAYLOAD_MISMATCH" });
	});

	test("wallet duplicada -> 409; wallet inexistente -> 404", () => {
		expect(mapError(new WalletAlreadyExistsError("p", "BRL")).status).toBe(409);
		expect(mapError(new WalletNotFoundError("w")).status).toBe(404);
	});

	test("falha transitória de infraestrutura -> 503 retriable com Retry-After", () => {
		const mapped = mapError(
			Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
		);
		expect(mapped.status).toBe(503);
		expect(mapped.retriable).toBe(true);
		expect(mapped.retryAfterSeconds).toBe(1);
	});

	test("erro inesperado -> 500 sem vazar a mensagem original", () => {
		const mapped = mapError(new Error("segredo interno"));
		expect(mapped.status).toBe(500);
		expect(mapped.message).not.toContain("segredo");
	});

	test("erro de programação do domínio (transição inválida) NÃO vira 4xx", () => {
		expect(
			mapError(new InvalidTransactionStateError("PROCESSED", "REJECTED"))
				.status,
		).toBe(500);
	});

	test("rota inexistente -> 404", () => {
		expect(mapError(new NotFoundException()).status).toBe(404);
	});
});

describe("isTransientInfrastructureError", () => {
	test("reconhece códigos do Postgres e erros de conexão aninhados", () => {
		expect(isTransientInfrastructureError({ code: "40P01" })).toBe(true);
		expect(
			isTransientInfrastructureError({
				code: "X",
				errors: [{ code: "ECONNREFUSED" }],
			}),
		).toBe(true);
		expect(isTransientInfrastructureError({ code: "23505" })).toBe(false);
		expect(isTransientInfrastructureError("texto")).toBe(false);
	});
});
