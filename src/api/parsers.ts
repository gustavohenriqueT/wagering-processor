import type { CreateWalletCommand } from "../application/create-wallet";
import type { ProcessWagerTransactionCommand } from "../application/process-wager-transaction";
import { DomainError } from "../domain/errors/domain-error";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { type FieldIssue, ValidationError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 255;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function asRecord(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ValidationError([
			{ field: "body", message: "o corpo deve ser um objeto JSON" },
		]);
	}
	return body as Record<string, unknown>;
}

function requiredText(
	source: Record<string, unknown>,
	field: string,
	issues: FieldIssue[],
): string {
	const value = source[field];
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ field, message: "obrigatório, texto não vazio" });
		return "";
	}
	if (value.length > MAX_TEXT) {
		issues.push({ field, message: `no máximo ${MAX_TEXT} caracteres` });
	}
	return value;
}

function parseMoney(
	value: unknown,
	field: string,
	issues: FieldIssue[],
): Money | undefined {
	if (typeof value !== "object" || value === null) {
		issues.push({
			field,
			message: 'obrigatório: { "amount": "10.00", "currency": "BRL" }',
		});
		return undefined;
	}
	try {
		const { amount, currency } = value as {
			amount?: unknown;
			currency?: unknown;
		};
		return Money.from({
			amount: amount as string,
			currency: currency as string,
		});
	} catch (error) {
		if (error instanceof DomainError) {
			issues.push({ field, message: `${error.code}: ${error.message}` });
			return undefined;
		}
		throw error;
	}
}

export function parseUuid(value: string, field: string): string {
	if (!UUID_PATTERN.test(value)) {
		throw new ValidationError([{ field, message: "deve ser um UUID" }]);
	}
	return value;
}

export function parseCreateWallet(
	body: unknown,
	correlationId: string,
): CreateWalletCommand {
	const source = asRecord(body);
	const issues: FieldIssue[] = [];
	const playerId = requiredText(source, "playerId", issues);
	const initialBalance = parseMoney(
		source.initialBalance,
		"initialBalance",
		issues,
	);
	if (issues.length > 0 || initialBalance === undefined) {
		throw new ValidationError(issues);
	}
	return { playerId, initialBalance, correlationId };
}

export function parseSubmitTransaction(
	body: unknown,
	idempotencyKey: string | undefined,
	correlationId: string,
): ProcessWagerTransactionCommand {
	const issues: FieldIssue[] = [];

	if (idempotencyKey === undefined || idempotencyKey.trim() === "") {
		issues.push({ field: "Idempotency-Key", message: "header obrigatório" });
	} else if (idempotencyKey.length > MAX_TEXT) {
		issues.push({
			field: "Idempotency-Key",
			message: `no máximo ${MAX_TEXT} caracteres`,
		});
	}

	const source = asRecord(body);
	const providerId = requiredText(source, "providerId", issues);
	const externalTransactionId = requiredText(
		source,
		"externalTransactionId",
		issues,
	);
	const playerId = requiredText(source, "playerId", issues);
	const roundId = requiredText(source, "roundId", issues);
	const gameId = requiredText(source, "gameId", issues);

	const walletId = typeof source.walletId === "string" ? source.walletId : "";
	if (!UUID_PATTERN.test(walletId)) {
		issues.push({
			field: "walletId",
			message: "obrigatório, deve ser um UUID",
		});
	}

	const kindValue = source.kind;
	const kind = Object.values(WagerTransactionKind).find(
		(candidate) => candidate === kindValue,
	);
	if (kind === undefined) {
		issues.push({
			field: "kind",
			message: `deve ser um de: ${Object.values(WagerTransactionKind)
				.filter((k) => k !== WagerTransactionKind.Opening)
				.join(", ")}`,
		});
	} else if (kind === WagerTransactionKind.Opening) {
		issues.push({
			field: "kind",
			message: "OPENING é interno e não pode ser submetido",
		});
	}

	const money = parseMoney(source.money, "money", issues);
	if (
		money !== undefined &&
		kind !== undefined &&
		kind !== WagerTransactionKind.Loss &&
		!money.isPositive()
	) {
		issues.push({
			field: "money",
			message: `${kind} exige valor maior que zero`,
		});
	}

	const reference = source.referenceExternalTransactionId;
	let referenceExternalTransactionId: string | undefined;
	if (reference !== undefined && reference !== null) {
		if (
			typeof reference !== "string" ||
			reference.trim() === "" ||
			reference.length > MAX_TEXT
		) {
			issues.push({
				field: "referenceExternalTransactionId",
				message: "texto não vazio",
			});
		} else {
			referenceExternalTransactionId = reference;
		}
	}
	if (
		(kind === WagerTransactionKind.Refund ||
			kind === WagerTransactionKind.Rollback) &&
		referenceExternalTransactionId === undefined
	) {
		issues.push({
			field: "referenceExternalTransactionId",
			message: `obrigatório para ${kind}`,
		});
	}

	if (
		issues.length > 0 ||
		kind === undefined ||
		money === undefined ||
		idempotencyKey === undefined
	) {
		throw new ValidationError(issues);
	}

	return {
		providerId,
		externalTransactionId,
		idempotencyKey,
		playerId,
		walletId,
		roundId,
		gameId,
		kind,
		money,
		...(referenceExternalTransactionId === undefined
			? {}
			: { referenceExternalTransactionId }),
		correlationId,
	};
}

export function encodeCursor(seq: string): string {
	return Buffer.from(JSON.stringify({ s: seq })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | undefined {
	if (cursor === undefined || cursor === "") {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		const seq = (parsed as { s?: unknown }).s;
		if (typeof seq === "string" && /^\d{1,18}$/.test(seq)) {
			return seq;
		}
	} catch {
	}
	throw new ValidationError([{ field: "cursor", message: "cursor inválido" }]);
}

export function parseLimit(value: string | undefined): number {
	if (value === undefined || value === "") {
		return DEFAULT_LIMIT;
	}
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new ValidationError([
			{ field: "limit", message: `inteiro entre 1 e ${MAX_LIMIT}` },
		]);
	}
	return limit;
}
