import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { canonicalJson, computePayloadHash } from "./payload-hash";

const base = {
	providerId: "prov-a",
	externalTransactionId: "ext-1",
	playerId: "p1",
	walletId: "w1",
	roundId: "r1",
	gameId: "g1",
	kind: WagerTransactionKind.Bet,
	money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("canonicalJson", () => {
	test("a ordem das chaves não importa, em qualquer nível", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
		);
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	test("undefined é omitido; null é preservado", () => {
		expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
	});
});

describe("computePayloadHash", () => {
	test("é determinístico", () => {
		expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
		expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("muda quando qualquer campo de negócio muda", () => {
		const original = computePayloadHash(base);
		expect(computePayloadHash({ ...base, roundId: "r2" })).not.toBe(original);
		expect(
			computePayloadHash({
				...base,
				money: Money.from({ amount: "25.01", currency: "BRL" }),
			}),
		).not.toBe(original);
		expect(
			computePayloadHash({ ...base, referenceExternalTransactionId: "x" }),
		).not.toBe(original);
	});
});
