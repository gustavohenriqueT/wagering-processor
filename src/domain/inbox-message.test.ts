import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors/domain-error";
import { InboxMessage } from "./inbox-message";

const t0 = new Date("2026-10-26T12:00:00.000Z");
const t1 = new Date("2026-10-26T12:00:05.000Z");

const base = {
	messageId: "msg-1",
	consumerName: "wager-consumer",
	payloadHash: "hash-1",
	receivedAt: t0,
};

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof DomainError ? error.code : undefined;
	}
	return undefined;
}

describe("InboxMessage", () => {
	test("receive: nasce não processada", () => {
		const message = InboxMessage.receive(base);
		expect(message.isProcessed()).toBe(false);
		expect(message.processedAt).toBeUndefined();
		expect(message.messageId).toBe("msg-1");
	});

	test("receive: rejeita campos vazios", () => {
		expect(
			codeOf(() => InboxMessage.receive({ ...base, messageId: "  " })),
		).toBe("INVALID_INBOX_MESSAGE");
		expect(
			codeOf(() => InboxMessage.receive({ ...base, consumerName: "" })),
		).toBe("INVALID_INBOX_MESSAGE");
		expect(
			codeOf(() => InboxMessage.receive({ ...base, payloadHash: "" })),
		).toBe("INVALID_INBOX_MESSAGE");
	});

	test("markProcessed registra o instante e torna a mensagem processada", () => {
		const message = InboxMessage.receive(base);
		message.markProcessed(t1);
		expect(message.isProcessed()).toBe(true);
		expect(message.processedAt).toEqual(t1);
	});

	test("processar no mesmo instante do recebimento é válido", () => {
		const message = InboxMessage.receive(base);
		message.markProcessed(t0);
		expect(message.isProcessed()).toBe(true);
	});

	test("não processa duas vezes", () => {
		const message = InboxMessage.receive(base);
		message.markProcessed(t1);
		expect(codeOf(() => message.markProcessed(t1))).toBe(
			"INBOX_ALREADY_PROCESSED",
		);
	});

	test("o processamento não pode anteceder o recebimento", () => {
		const message = InboxMessage.receive(base);
		expect(
			codeOf(() => message.markProcessed(new Date("2026-10-26T11:59:59.000Z"))),
		).toBe("INBOX_INVALID_PROCESSING_TIME");
		expect(message.isProcessed()).toBe(false);
	});

	test("rehydrate não revalida: restaura o estado salvo", () => {
		const message = InboxMessage.rehydrate({ ...base, processedAt: t1 });
		expect(message.isProcessed()).toBe(true);
		expect(message.processedAt).toEqual(t1);
	});
});
