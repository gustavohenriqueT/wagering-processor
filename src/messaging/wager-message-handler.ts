import { ValidationError } from "../api/errors";
import { parseSubmitTransaction } from "../api/parsers";
import { isTransientInfrastructureError } from "../application/db-errors";
import {
	IdempotencyConflictError,
	WalletNotFoundError,
} from "../application/errors";
import type {
	ProcessWagerTransaction,
	ProcessWagerTransactionResult,
} from "../application/process-wager-transaction";
import { DomainError } from "../domain/errors/domain-error";

export interface MessageContext {
	attempt: number;
	maxAttempts: number;
}

export type MessageOutcome =
	| {
			action: "ack";
			result: ProcessWagerTransactionResult;
			walletId: string;
			providerId: string;
			messageId: string;
			kind: string;
	  }
	| { action: "retry"; reason: string; messageId?: string }
	| {
			action: "dead-letter";
			reason: string;
			detail?: string;
			messageId?: string;
	  };

export const CONSUMER_NAME = "wager-transactions-consumer";
const MESSAGE_TYPE = "WagerTransactionRequested";

export class WagerMessageHandler {
	constructor(
		private readonly processTransaction: Pick<
			ProcessWagerTransaction,
			"execute"
		>,
		private readonly consumerName: string = CONSUMER_NAME,
	) {}

	async handle(body: string, context: MessageContext): Promise<MessageOutcome> {
		let envelope: unknown;
		try {
			envelope = JSON.parse(body);
		} catch {
			return { action: "dead-letter", reason: "INVALID_JSON" };
		}

		const record =
			typeof envelope === "object" && envelope !== null
				? (envelope as Record<string, unknown>)
				: {};
		const messageId =
			typeof record.messageId === "string" ? record.messageId.trim() : "";
		if (
			messageId === "" ||
			record.type !== MESSAGE_TYPE ||
			typeof record.data !== "object" ||
			record.data === null
		) {
			return {
				action: "dead-letter",
				reason: "INVALID_MESSAGE",
				detail: `esperado { messageId, type: "${MESSAGE_TYPE}", data }`,
				...(messageId === "" ? {} : { messageId }),
			};
		}

		const data = record.data as Record<string, unknown>;
		let command;
		try {
			command = parseSubmitTransaction(
				data,
				typeof data.idempotencyKey === "string"
					? data.idempotencyKey
					: undefined,
				messageId,
			);
		} catch (error) {
			if (error instanceof ValidationError) {
				return {
					action: "dead-letter",
					reason: "VALIDATION_ERROR",
					detail: error.issues
						.map((issue) => `${issue.field}: ${issue.message}`)
						.join("; "),
					messageId,
				};
			}
			throw error;
		}

		try {
			const result = await this.processTransaction.execute({
				...command,
				inbox: { consumerName: this.consumerName, messageId },
			});
			return {
				action: "ack",
				result,
				walletId: command.walletId,
				providerId: command.providerId,
				messageId,
				kind: command.kind,
			};
		} catch (error) {
			return this.classifyFailure(error, context, messageId);
		}
	}

	private classifyFailure(
		error: unknown,
		context: MessageContext,
		messageId: string,
	): MessageOutcome {
		if (error instanceof WalletNotFoundError) {
			return {
				action: "dead-letter",
				reason: "WALLET_NOT_FOUND",
				detail: error.message,
				messageId,
			};
		}
		if (error instanceof IdempotencyConflictError) {
			return {
				action: "dead-letter",
				reason: "IDEMPOTENCY_CONFLICT",
				detail: error.message,
				messageId,
			};
		}
		if (error instanceof DomainError) {
			return {
				action: "dead-letter",
				reason: error.code,
				detail: error.message,
				messageId,
			};
		}

		const reason = isTransientInfrastructureError(error)
			? "TRANSIENT_ERROR"
			: "UNEXPECTED_ERROR";
		const detail = error instanceof Error ? error.message : String(error);
		if (context.attempt >= context.maxAttempts) {
			return {
				action: "dead-letter",
				reason: "MAX_ATTEMPTS_EXCEEDED",
				detail: `${reason}: ${detail}`,
				messageId,
			};
		}
		return { action: "retry", reason: `${reason}: ${detail}`, messageId };
	}
}
