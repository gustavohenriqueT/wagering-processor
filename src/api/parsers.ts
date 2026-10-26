import type { CreateWalletCommand } from "../application/create-wallet";
import {
	asRecord,
	parseMoney,
	requiredText,
	UUID_PATTERN,
} from "../application/request-parsing";
import {
	type FieldIssue,
	ValidationError,
} from "../application/validation-error";

export { parseSubmitTransaction } from "../application/request-parsing";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
	} catch {}
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
