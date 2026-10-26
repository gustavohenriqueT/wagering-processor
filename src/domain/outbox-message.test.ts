import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors/domain-error";
import {
	DEFAULT_OUTBOX_BACKOFF,
	type EnqueuableEvent,
	OutboxMessage,
} from "./outbox-message";

const t0 = new Date("2026-10-26T12:00:00.000Z");

function event(overrides: Partial<EnqueuableEvent> = {}): EnqueuableEvent {
	return {
		eventId: "0192f298-345e-7e38-af88-e43f851a819d",
		aggregateId: "wallet-1",
		eventType: "WalletBalanceChanged",
		occurredAt: t0,
		toJSON: () => ({
			eventId: "e1",
			data: { balance: { amount: "70.00", currency: "BRL" } },
			ignored: undefined,
		}),
		...overrides,
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

describe("OutboxMessage.enqueue", () => {
	test("nasce pendente, sem tentativas, com o id do evento", () => {
		const message = OutboxMessage.enqueue(event());
		expect(message.id).toBe("0192f298-345e-7e38-af88-e43f851a819d");
		expect(message.aggregateId).toBe("wallet-1");
		expect(message.eventType).toBe("WalletBalanceChanged");
		expect(message.isPending()).toBe(true);
		expect(message.attempts).toBe(0);
		expect(message.nextAttemptAt).toBeUndefined();
		expect(message.publishedAt).toBeUndefined();
	});

	test("o payload é uma cópia JSON imutável (sem undefined)", () => {
		const message = OutboxMessage.enqueue(event());
		expect(message.payload).toEqual({
			eventId: "e1",
			data: { balance: { amount: "70.00", currency: "BRL" } },
		});
		expect(Object.isFrozen(message.payload)).toBe(true);
		expect("ignored" in message.payload).toBe(false);
	});
});

describe("OutboxMessage: publicação", () => {
	test("markPublished conta a tentativa, registra a publicação e sai de pendente", () => {
		const message = OutboxMessage.enqueue(event());
		message.markPublished(t0);
		expect(message.isPending()).toBe(false);
		expect(message.publishedAt).toEqual(t0);
		expect(message.attempts).toBe(1);
	});

	test("estado terminal: não publica nem reagenda de novo", () => {
		const message = OutboxMessage.enqueue(event());
		message.markPublished(t0);
		expect(codeOf(() => message.markPublished(t0))).toBe(
			"OUTBOX_ALREADY_PUBLISHED",
		);
		expect(codeOf(() => message.scheduleRetry(t0))).toBe(
			"OUTBOX_ALREADY_PUBLISHED",
		);
	});
});

describe("OutboxMessage: retry com backoff", () => {
	const backoff = { baseMs: 1_000, maxMs: 10_000 };

	test("o atraso dobra a cada falha e respeita o teto", () => {
		const message = OutboxMessage.enqueue(event());
		const delays: number[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) {
			message.scheduleRetry(t0, backoff);
			delays.push((message.nextAttemptAt?.getTime() ?? 0) - t0.getTime());
		}
		expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
		expect(message.attempts).toBe(6);
	});

	test("usa o backoff padrão quando nenhum é informado", () => {
		const message = OutboxMessage.enqueue(event());
		message.scheduleRetry(t0);
		expect((message.nextAttemptAt?.getTime() ?? 0) - t0.getTime()).toBe(
			DEFAULT_OUTBOX_BACKOFF.baseMs,
		);
	});

	test("isDue: vence só depois do agendamento", () => {
		const message = OutboxMessage.enqueue(event());
		expect(message.isDue(t0)).toBe(true);
		message.scheduleRetry(t0, backoff);
		expect(message.isDue(new Date(t0.getTime() + 999))).toBe(false);
		expect(message.isDue(new Date(t0.getTime() + 1_000))).toBe(true);
	});

	test("uma mensagem publicada nunca está vencida", () => {
		const message = OutboxMessage.enqueue(event());
		message.markPublished(t0);
		expect(message.isDue(new Date(t0.getTime() + 1_000_000))).toBe(false);
	});

	test("uma publicação bem-sucedida depois de falhas limpa o agendamento", () => {
		const message = OutboxMessage.enqueue(event());
		message.scheduleRetry(t0, backoff);
		message.markPublished(new Date(t0.getTime() + 2_000));
		expect(message.nextAttemptAt).toBeUndefined();
		expect(message.attempts).toBe(2);
	});
});

describe("OutboxMessage.rehydrate", () => {
	test("restaura o estado salvo sem revalidar", () => {
		const message = OutboxMessage.rehydrate({
			id: "e1",
			aggregateId: "w1",
			eventType: "X",
			payload: { a: 1 },
			occurredAt: t0,
			attempts: 3,
			nextAttemptAt: new Date(t0.getTime() + 5_000),
		});
		expect(message.attempts).toBe(3);
		expect(message.isPending()).toBe(true);
		expect(message.nextAttemptAt).toEqual(new Date(t0.getTime() + 5_000));
	});
});
