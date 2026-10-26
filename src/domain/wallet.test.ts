import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors/domain-error";
import { Money } from "./money";
import { Wallet } from "./wallet";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

const t0 = new Date("2026-10-25T00:00:00Z");
const t1 = new Date("2026-10-25T00:01:00Z");

function openWallet(initial = "100.00"): Wallet {
	return Wallet.open({
		id: "w1",
		playerId: "p1",
		initialBalance: brl(initial),
		now: t0,
	});
}

function movement(amount: string, n = 1) {
	return {
		money: brl(amount),
		entryId: `e${n}`,
		transactionId: `t${n}`,
		at: t1,
	};
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof DomainError ? error.code : undefined;
	}
	return undefined;
}

describe("Wallet.open", () => {
	test("nasce com version 1, saldo inicial e moeda do saldo", () => {
		const wallet = openWallet();
		expect(wallet.version).toBe(1);
		expect(wallet.balance.toJSON().amount).toBe("100.00");
		expect(wallet.currency).toBe("BRL");
	});

	test("aceita saldo inicial zero", () => {
		expect(openWallet("0.00").balance.isZero()).toBe(true);
	});

	test("rejeita saldo inicial negativo", () => {
		const code = codeOf(() =>
			Wallet.open({
				id: "w1",
				playerId: "p1",
				initialBalance: brl("1.00").negate(),
				now: t0,
			}),
		);
		expect(code).toBe("INVALID_INITIAL_BALANCE");
	});
});

describe("debit e credit", () => {
	test("debit reduz o saldo, incrementa version e devolve lançamento consistente", () => {
		const wallet = openWallet();
		const entry = wallet.debit(movement("30.00"));
		expect(wallet.balance.toJSON().amount).toBe("70.00");
		expect(wallet.version).toBe(2);
		expect(wallet.updatedAt).toEqual(t1);
		expect(entry.isBalanced()).toBe(true);
		expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
		expect(entry.balanceAfter.toJSON().amount).toBe("70.00");
	});

	test("credit aumenta o saldo", () => {
		const wallet = openWallet();
		wallet.credit(movement("25.50"));
		expect(wallet.balance.toJSON().amount).toBe("125.50");
	});

	test("débito que zera a wallet é permitido (fronteira)", () => {
		const wallet = openWallet("10.00");
		wallet.debit(movement("10.00"));
		expect(wallet.balance.isZero()).toBe(true);
	});

	test("lançamentos consecutivos encadeiam: before do segundo = after do primeiro", () => {
		const wallet = openWallet();
		const first = wallet.debit(movement("30.00", 1));
		const second = wallet.credit(movement("10.00", 2));
		expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
		expect(wallet.version).toBe(3);
	});
});

describe("rejeições não alteram a wallet", () => {
	test("saldo insuficiente", () => {
		const wallet = openWallet("10.00");
		expect(codeOf(() => wallet.debit(movement("10.01")))).toBe(
			"INSUFFICIENT_FUNDS",
		);
		expect(wallet.balance.toJSON().amount).toBe("10.00");
		expect(wallet.version).toBe(1);
	});

	test("moeda diferente", () => {
		const wallet = openWallet();
		const code = codeOf(() =>
			wallet.debit({
				money: usd("1.00"),
				entryId: "e1",
				transactionId: "t1",
				at: t1,
			}),
		);
		expect(code).toBe("CURRENCY_MISMATCH");
		expect(wallet.version).toBe(1);
	});

	test("valor zero não muda version", () => {
		const wallet = openWallet();
		expect(codeOf(() => wallet.credit(movement("0.00")))).toBe(
			"INVALID_MOVEMENT_AMOUNT",
		);
		expect(wallet.version).toBe(1);
	});
});

describe("Wallet.rehydrate", () => {
	test("preserva a version salva, sem revalidar", () => {
		const wallet = Wallet.rehydrate({
			id: "w1",
			playerId: "p1",
			currency: "BRL",
			balance: brl("42.00"),
			version: 7,
			createdAt: t0,
			updatedAt: t1,
		});
		expect(wallet.version).toBe(7);
		expect(wallet.balance.toJSON().amount).toBe("42.00");
	});
});
