import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../domain/failure-code";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { WagerTransactionRejected, WalletBalanceChanged } from "./wager-events";

const occurredAt = new Date("2026-10-25T12:00:00.000Z");
const money = { amount: "30.00", currency: "BRL" };

describe("IntegrationEvent", () => {
	test("toJSON traz eventType e version do TIPO, e a data em ISO-8601", () => {
		const event = new WalletBalanceChanged({
			eventId: "e1",
			aggregateId: "w1",
			correlationId: "c1",
			occurredAt,
			data: {
				walletId: "w1",
				transactionId: "t1",
				direction: LedgerDirection.Debit,
				money,
				balanceBefore: { amount: "100.00", currency: "BRL" },
				balanceAfter: { amount: "70.00", currency: "BRL" },
				walletVersion: 2,
			},
		});
		const json = event.toJSON();
		expect(json.eventType).toBe("WalletBalanceChanged");
		expect(json.version).toBe(1);
		expect(json.occurredAt).toBe("2026-10-25T12:00:00.000Z");
		expect(json.data.balanceAfter.amount).toBe("70.00");
	});

	test("causationId só aparece quando existe", () => {
		const base = {
			eventId: "e1",
			aggregateId: "w1",
			correlationId: "c1",
			occurredAt,
			data: {
				transactionId: "t1",
				walletId: "w1",
				providerId: "p",
				externalTransactionId: "x",
				kind: WagerTransactionKind.Bet,
				money,
				balance: money,
				failureCode: FailureCode.InsufficientFunds,
			},
		};
		expect("causationId" in new WagerTransactionRejected(base).toJSON()).toBe(
			false,
		);
		expect(
			new WagerTransactionRejected({
				...base,
				causationId: "msg-1",
			}).toJSON().causationId,
		).toBe("msg-1");
	});

	test("data é imutável em tempo de execução", () => {
		const event = new WagerTransactionRejected({
			eventId: "e1",
			aggregateId: "w1",
			correlationId: "c1",
			occurredAt,
			data: {
				transactionId: "t1",
				walletId: "w1",
				providerId: "p",
				externalTransactionId: "x",
				kind: WagerTransactionKind.Bet,
				money,
				balance: money,
				failureCode: FailureCode.InsufficientFunds,
			},
		});
		expect(Object.isFrozen(event.data)).toBe(true);
	});
});
