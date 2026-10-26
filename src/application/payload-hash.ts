import { createHash } from "node:crypto";
import type { Money } from "../domain/money";
import type { WagerTransactionKind } from "../domain/wager-transaction";

/** JSON canônico: chaves ordenadas recursivamente, sem espaços, `undefined` omitido. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

export interface PayloadHashInput {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	referenceExternalTransactionId?: string;
}

/**
 * SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Ficam de fora: o header Idempotency-Key e metadados de transporte (correlationId etc.).
 */
export function computePayloadHash(input: PayloadHashInput): string {
	const canonical = canonicalJson({
		providerId: input.providerId,
		externalTransactionId: input.externalTransactionId,
		playerId: input.playerId,
		walletId: input.walletId,
		roundId: input.roundId,
		gameId: input.gameId,
		kind: input.kind,
		money: input.money.toJSON(),
		referenceExternalTransactionId:
			input.referenceExternalTransactionId ?? null,
	});
	return createHash("sha256").update(canonical).digest("hex");
}
