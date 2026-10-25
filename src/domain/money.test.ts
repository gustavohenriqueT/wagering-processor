import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/errors/domain-error";
import { Money } from "../../src/domain/money/money";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
	test("aceita decimal válido e serializa com escala 2", () => {
		expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
	});

	test("aceita zero", () => {
		expect(brl("0.00").isZero()).toBe(true);
	});

	test("aceita o maior valor que cabe em numeric(19,2)", () => {
		expect(brl("99999999999999999.99").toJSON().amount).toBe(
			"99999999999999999.99",
		);
	});

	test("rejeita 18 dígitos inteiros (estouraria a coluna do banco)", () => {
		expect(() => brl("100000000000000000.00")).toThrow(DomainError);
	});

	test.each([
		"NaN",
		"Infinity",
		"-Infinity",
		"1e3",
		"1E3",
		"",
		"   ",
		"-5.00",
		"+5.00",
		"1.234",
		"abc",
		".50",
		"5.",
		"1,50",
		" 5.00",
	])("rejeita entrada inválida: %p", (amount) => {
		expect(() => brl(amount)).toThrow(DomainError);
	});

	test("rejeita amount que não é string (JSON pode trazer número)", () => {
		expect(() =>
			Money.from({ amount: 25 as unknown as string, currency: "BRL" }),
		).toThrow(DomainError);
	});

	test.each(["brl", "BR", "BRLL", "", "R$"])(
		"rejeita moeda inválida: %p",
		(currency) => {
			expect(() => Money.from({ amount: "1.00", currency })).toThrow(
				DomainError,
			);
		},
	);
});

describe("aritmética", () => {
	test("0.10 + 0.20 é exatamente 0.30 (onde float erra)", () => {
		expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
	});

	test("subtract", () => {
		expect(brl("100.00").subtract(brl("30.00")).toJSON().amount).toBe("70.00");
	});

	test("subtract pode resultar em negativo", () => {
		const result = brl("10.00").subtract(brl("25.00"));
		expect(result.toJSON().amount).toBe("-15.00");
		expect(result.isNegative()).toBe(true);
	});

	test("negate", () => {
		expect(brl("5.00").negate().toJSON().amount).toBe("-5.00");
	});

	test("é imutável: operações não alteram o original", () => {
		const a = brl("10.00");
		a.add(brl("5.00"));
		expect(a.toJSON().amount).toBe("10.00");
	});

	test("zero(currency)", () => {
		expect(Money.zero("BRL").toJSON()).toEqual({
			amount: "0.00",
			currency: "BRL",
		});
	});
});

describe("moedas diferentes", () => {
	test("add lança CURRENCY_MISMATCH", () => {
		expect(() => brl("1.00").add(usd("1.00"))).toThrow(DomainError);
	});

	test("subtract lança erro de domínio", () => {
		expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(DomainError);
	});

	test("isLessThan lança erro de domínio", () => {
		expect(() => brl("1.00").isLessThan(usd("2.00"))).toThrow(DomainError);
	});
});

describe("comparações", () => {
	test("isPositive / isNegative / isZero", () => {
		expect(brl("1.00").isPositive()).toBe(true);
		expect(brl("0.00").isPositive()).toBe(false);
		expect(brl("0.00").isNegative()).toBe(false);
		expect(brl("1.00").negate().isNegative()).toBe(true);
	});

	test("isLessThan", () => {
		expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
		expect(brl("2.00").isLessThan(brl("2.00"))).toBe(false);
	});

	test("equals com mesma moeda", () => {
		expect(brl("2.00").equals(brl("2.00"))).toBe(true);
		expect(brl("2.00").equals(brl("2.01"))).toBe(false);
	});
});
