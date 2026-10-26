import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/errors/domain-error";
import { Money } from "../../src/domain/money/money";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../../src/domain/money/wallet-ledger-entry";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

const base = {
	id: "entry-1",
	walletId: "wallet-1",
	transactionId: "tx-1",
	createdAt: new Date("2026-10-25T00:00:00Z"),
};

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof DomainError ? error.code : undefined;
	}
	return undefined;
}

describe("WalletLedgerEntry.create", () => {
	test("débito válido: 100.00 - 30.00 = 70.00", () => {
		const entry = WalletLedgerEntry.create({
			...base,
			direction: LedgerDirection.Debit,
			money: brl("30.00"),
			balanceBefore: brl("100.00"),
			balanceAfter: brl("70.00"),
		});
		expect(entry.isBalanced()).toBe(true);
	});

	test("crédito válido: 70.00 + 30.00 = 100.00", () => {
		const entry = WalletLedgerEntry.create({
			...base,
			direction: LedgerDirection.Credit,
			money: brl("30.00"),
			balanceBefore: brl("70.00"),
			balanceAfter: brl("100.00"),
		});
		expect(entry.isBalanced()).toBe(true);
	});

	test("rejeita aritmética errada", () => {
		const code = codeOf(() =>
			WalletLedgerEntry.create({
				...base,
				direction: LedgerDirection.Debit,
				money: brl("30.00"),
				balanceBefore: brl("100.00"),
				balanceAfter: brl("80.00"),
			}),
		);
		expect(code).toBe("LEDGER_ENTRY_UNBALANCED");
	});

	test("rejeita valor zero", () => {
		const code = codeOf(() =>
			WalletLedgerEntry.create({
				...base,
				direction: LedgerDirection.Credit,
				money: brl("0.00"),
				balanceBefore: brl("10.00"),
				balanceAfter: brl("10.00"),
			}),
		);
		expect(code).toBe("LEDGER_AMOUNT_NOT_POSITIVE");
	});

	test("rejeita saldo resultante negativo", () => {
		const code = codeOf(() =>
			WalletLedgerEntry.create({
				...base,
				direction: LedgerDirection.Debit,
				money: brl("150.00"),
				balanceBefore: brl("100.00"),
				balanceAfter: brl("50.00").negate(),
			}),
		);
		expect(code).toBe("LEDGER_NEGATIVE_BALANCE");
	});

	test("rejeita moedas misturadas", () => {
		const code = codeOf(() =>
			WalletLedgerEntry.create({
				...base,
				direction: LedgerDirection.Debit,
				money: usd("30.00"),
				balanceBefore: brl("100.00"),
				balanceAfter: brl("70.00"),
			}),
		);
		expect(code).toBe("CURRENCY_MISMATCH");
	});
});

describe("WalletLedgerEntry.rehydrate", () => {
	test("não revalida: carrega estado corrompido, e isBalanced() o detecta", () => {
		const entry = WalletLedgerEntry.rehydrate({
			...base,
			direction: LedgerDirection.Debit,
			money: brl("30.00"),
			balanceBefore: brl("100.00"),
			balanceAfter: brl("80.00"),
		});
		expect(entry.isBalanced()).toBe(false);
	});
});

describe("imutabilidade", () => {
	test("o objeto é congelado em tempo de execução", () => {
		const entry = WalletLedgerEntry.create({
			...base,
			direction: LedgerDirection.Credit,
			money: brl("1.00"),
			balanceBefore: brl("0.00"),
			balanceAfter: brl("1.00"),
		});
		expect(Object.isFrozen(entry)).toBe(true);
		expect(() => {
			(entry as unknown as { direction: string }).direction = "DEBIT";
		}).toThrow();
	});
});
