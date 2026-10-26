import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors/domain-error";
import { FailureCode } from "./failure-code";
import { Money } from "./money";
import {
	type CreateWagerTransactionProps,
	WagerTransaction,
	WagerTransactionKind,
	WagerTransactionStatus,
} from "./wager-transaction";
import { LedgerDirection } from "./wallet-ledger-entry";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-25T00:00:00Z");

function make(
	overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
	return WagerTransaction.create({
		id: "tx-1",
		providerId: "prov-a",
		externalTransactionId: "ext-1",
		idempotencyKey: "prov-a:ext-1",
		payloadHash: "hash-1",
		walletId: "w1",
		playerId: "p1",
		roundId: "r1",
		gameId: "g1",
		kind: WagerTransactionKind.Bet,
		money: brl("30.00"),
		createdAt: at,
		...overrides,
	});
}

function processed(
	overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
	const tx = make(overrides);
	tx.markProcessed(undefined, at);
	return tx;
}

function refund(
	overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
	return make({
		id: "tx-r",
		externalTransactionId: "ext-r",
		idempotencyKey: "prov-a:ext-r",
		kind: WagerTransactionKind.Refund,
		referenceExternalTransactionId: "ext-1",
		...overrides,
	});
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof DomainError ? error.code : undefined;
	}
	return undefined;
}

describe("WagerTransaction.create", () => {
	test("nasce em PENDING e não é terminal", () => {
		const tx = make();
		expect(tx.status).toBe(WagerTransactionStatus.Pending);
		expect(tx.isTerminal()).toBe(false);
	});

	test("REFUND sem referência é rejeitado", () => {
		expect(codeOf(() => make({ kind: WagerTransactionKind.Refund }))).toBe(
			"REFERENCE_REQUIRED",
		);
	});

	test("ROLLBACK sem referência é rejeitado", () => {
		expect(codeOf(() => make({ kind: WagerTransactionKind.Rollback }))).toBe(
			"REFERENCE_REQUIRED",
		);
	});

	test("WIN pode ter referência opcional", () => {
		const tx = make({
			kind: WagerTransactionKind.Win,
			referenceExternalTransactionId: "ext-bet",
		});
		expect(tx.referenceExternalTransactionId).toBe("ext-bet");
	});

	test("BET com valor zero é rejeitada", () => {
		expect(codeOf(() => make({ money: brl("0.00") }))).toBe("INVALID_AMOUNT");
	});

	test("LOSS aceita valor zero", () => {
		expect(
			make({
				kind: WagerTransactionKind.Loss,
				money: brl("0.00"),
			}).affectsBalance(),
		).toBe(false);
	});
});

describe("transições", () => {
	test("PENDING -> PROCESSED define processedAt e torna terminal", () => {
		const tx = make();
		tx.markProcessed(undefined, at);
		expect(tx.status).toBe(WagerTransactionStatus.Processed);
		expect(tx.processedAt).toEqual(at);
		expect(tx.isTerminal()).toBe(true);
	});

	test("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
		const tx = refund();
		tx.markPendingReference();
		expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
		tx.markProcessed("bet-id", at);
		expect(tx.status).toBe(WagerTransactionStatus.Processed);
		expect(tx.referenceTransactionId).toBe("bet-id");
	});

	test("reject registra o failureCode e torna terminal", () => {
		const tx = make();
		tx.reject(FailureCode.InsufficientFunds);
		expect(tx.status).toBe(WagerTransactionStatus.Rejected);
		expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
		expect(tx.processedAt).toBeUndefined();
		expect(tx.isTerminal()).toBe(true);
	});

	test("fail registra o failureCode e torna terminal", () => {
		const tx = make();
		tx.fail(FailureCode.InternalError);
		expect(tx.status).toBe(WagerTransactionStatus.Failed);
		expect(tx.isTerminal()).toBe(true);
	});

	test("estado terminal não transiciona", () => {
		const tx = processed();
		expect(codeOf(() => tx.reject(FailureCode.InternalError))).toBe(
			"INVALID_TRANSACTION_STATE",
		);
		expect(tx.status).toBe(WagerTransactionStatus.Processed);
	});

	test("PENDING_REFERENCE -> PENDING_REFERENCE não é transição válida", () => {
		const tx = refund();
		tx.markPendingReference();
		expect(codeOf(() => tx.markPendingReference())).toBe(
			"INVALID_TRANSACTION_STATE",
		);
	});

	test("REFUND não pode ser processado sem o id da referência", () => {
		const tx = refund();
		expect(codeOf(() => tx.markProcessed(undefined, at))).toBe(
			"REFERENCE_REQUIRED",
		);
		expect(tx.status).toBe(WagerTransactionStatus.Pending);
	});
});

describe("consultas de domínio", () => {
	test("affectsBalance é falso só para LOSS", () => {
		expect(make({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(
			false,
		);
		expect(make({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(
			true,
		);
		expect(make().affectsBalance()).toBe(true);
	});

	test("requiresReference é verdadeiro só para REFUND e ROLLBACK", () => {
		expect(refund().requiresReference()).toBe(true);
		expect(make().requiresReference()).toBe(false);
		expect(make({ kind: WagerTransactionKind.Win }).requiresReference()).toBe(
			false,
		);
	});

	test("matchesPayload compara o hash", () => {
		const tx = make();
		expect(tx.matchesPayload("hash-1")).toBe(true);
		expect(tx.matchesPayload("outro")).toBe(false);
	});
});

describe("ledgerDirectionFor", () => {
	test("BET debita; WIN, REFUND e OPENING creditam", () => {
		expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
		expect(make({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
			LedgerDirection.Credit,
		);
		expect(refund().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
		expect(
			make({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor(),
		).toBe(LedgerDirection.Credit);
	});

	test("LOSS não tem efeito no ledger", () => {
		expect(
			codeOf(() =>
				make({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor(),
			),
		).toBe("NO_LEDGER_EFFECT");
	});

	test("ROLLBACK de BET credita (inverso do débito)", () => {
		const rollback = make({
			kind: WagerTransactionKind.Rollback,
			referenceExternalTransactionId: "ext-1",
		});
		expect(rollback.ledgerDirectionFor(processed())).toBe(
			LedgerDirection.Credit,
		);
	});

	test("ROLLBACK de WIN ou de REFUND debita (inverso do crédito)", () => {
		const rollback = make({
			kind: WagerTransactionKind.Rollback,
			referenceExternalTransactionId: "ext-x",
		});
		const win = processed({ kind: WagerTransactionKind.Win });
		expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
		expect(rollback.ledgerDirectionFor(refund())).toBe(LedgerDirection.Debit);
	});

	test("ROLLBACK sem a transação referenciada lança erro", () => {
		const rollback = make({
			kind: WagerTransactionKind.Rollback,
			referenceExternalTransactionId: "ext-1",
		});
		expect(codeOf(() => rollback.ledgerDirectionFor())).toBe(
			"REFERENCE_REQUIRED",
		);
	});
});

describe("checkReference", () => {
	test("referência compatível devolve undefined", () => {
		expect(refund().checkReference(processed())).toBeUndefined();
	});

	test("REFUND só referencia BET", () => {
		const win = processed({ kind: WagerTransactionKind.Win });
		expect(refund().checkReference(win)).toBe(FailureCode.InvalidReferenceKind);
	});

	test("jogador diferente é REFERENCE_MISMATCH", () => {
		expect(refund().checkReference(processed({ playerId: "p2" }))).toBe(
			FailureCode.ReferenceMismatch,
		);
	});

	test("valor diferente é AMOUNT_MISMATCH", () => {
		expect(refund({ money: brl("10.00") }).checkReference(processed())).toBe(
			FailureCode.AmountMismatch,
		);
	});

	test("referência ainda não processada é REFERENCE_NOT_PROCESSED", () => {
		expect(refund().checkReference(make())).toBe(
			FailureCode.ReferenceNotProcessed,
		);
	});
});

describe("WagerTransaction.rehydrate", () => {
	test("restaura o estado salvo sem revalidar", () => {
		const tx = WagerTransaction.rehydrate({
			id: "tx-9",
			providerId: "prov-a",
			externalTransactionId: "ext-9",
			idempotencyKey: "prov-a:ext-9",
			payloadHash: "h",
			walletId: "w1",
			playerId: "p1",
			roundId: "r1",
			gameId: "g1",
			kind: WagerTransactionKind.Bet,
			money: brl("5.00"),
			createdAt: at,
			status: WagerTransactionStatus.Rejected,
			failureCode: FailureCode.InsufficientFunds,
		});
		expect(tx.status).toBe(WagerTransactionStatus.Rejected);
		expect(tx.isTerminal()).toBe(true);
	});
});
