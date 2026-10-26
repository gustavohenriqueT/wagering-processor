import {
	ChangeMessageVisibilityCommand,
	DeleteMessageCommand,
	type Message,
	ReceiveMessageCommand,
	SendMessageCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import { type Logger, silentLogger } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { sleep } from "../observability/sleep";
import type {
	MessageOutcome,
	WagerMessageHandler,
} from "./wager-message-handler";

export interface SqsConsumerOptions {
	queueUrl: string;
	dlqUrl: string;
	maxAttempts: number;
	waitTimeSeconds: number;
	maxMessages: number;
	retryBaseDelaySeconds: number;
	retryMaxDelaySeconds: number;
}

export const DEFAULT_CONSUMER_OPTIONS = {
	maxAttempts: 5,
	waitTimeSeconds: 20,
	maxMessages: 10,
	retryBaseDelaySeconds: 2,
	retryMaxDelaySeconds: 120,
};

export class SqsConsumer {
	private readonly abort = new AbortController();
	private readonly loops: Promise<void>[] = [];

	constructor(
		private readonly sqs: SQSClient,
		private readonly handler: Pick<WagerMessageHandler, "handle">,
		private readonly options: SqsConsumerOptions,
		private readonly metrics: Metrics = new Metrics(),
		private readonly logger: Logger = silentLogger,
	) {}

	start(concurrency = 1): void {
		for (let index = 0; index < concurrency; index += 1) {
			this.loops.push(this.run());
		}
	}

	async stop(): Promise<void> {
		this.abort.abort();
		await Promise.all(this.loops);
	}

	private get stopping(): boolean {
		return this.abort.signal.aborted;
	}

	private async run(): Promise<void> {
		while (!this.stopping) {
			try {
				const messages = await this.receive();
				await this.processBatch(messages);
			} catch (error) {
				if (this.stopping) {
					return;
				}
				this.logger.log("error", "sqs_loop_error", {
					error: error instanceof Error ? error.message : String(error),
				});
				await sleep(1_000, this.abort.signal);
			}
		}
	}

	private async receive(): Promise<Message[]> {
		const response = await this.sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: this.options.queueUrl,
				MaxNumberOfMessages: this.options.maxMessages,
				WaitTimeSeconds: this.options.waitTimeSeconds,
				MessageSystemAttributeNames: [
					"ApproximateReceiveCount",
					"MessageGroupId",
				],
			}),
			{ abortSignal: this.abort.signal },
		);
		return response.Messages ?? [];
	}

	async processBatch(messages: Message[]): Promise<void> {
		const groups = new Map<string, Message[]>();
		for (const message of messages) {
			const group = message.Attributes?.MessageGroupId ?? "no-group";
			groups.set(group, [...(groups.get(group) ?? []), message]);
		}
		await Promise.all(
			[...groups.values()].map(async (groupMessages) => {
				for (const message of groupMessages) {
					if (this.stopping) {
						await this.release(message);
					} else {
						await this.processMessage(message);
					}
				}
			}),
		);
	}

	private async processMessage(message: Message): Promise<void> {
		const startedAt = performance.now();
		const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
		let outcome: MessageOutcome;
		try {
			outcome = await this.handler.handle(message.Body ?? "", {
				attempt,
				maxAttempts: this.options.maxAttempts,
			});
		} catch (error) {
			outcome = {
				action: attempt >= this.options.maxAttempts ? "dead-letter" : "retry",
				reason: `HANDLER_CRASH: ${error instanceof Error ? error.message : String(error)}`,
			} as MessageOutcome;
		}

		switch (outcome.action) {
			case "ack": {
				await this.delete(message);
				const duplicate = outcome.result.replayedBy !== undefined;
				this.metrics.inc("sqs_messages_total", {
					outcome: duplicate ? "duplicate" : "processed",
				});
				this.metrics.inc("wager_transactions_total", {
					kind: outcome.kind,
					status: outcome.result.status,
					replay: String(outcome.result.idempotentReplay),
				});
				if (duplicate) {
					this.metrics.inc("duplicates_detected_total", {
						source: outcome.result.replayedBy ?? "unknown",
					});
				}
				this.logger.log(
					"info",
					duplicate ? "message_duplicate_acked" : "message_acked",
					{
						messageId: outcome.messageId,
						correlationId: outcome.messageId,
						transactionId: outcome.result.transactionId,
						walletId: outcome.walletId,
						providerId: outcome.providerId,
						status: outcome.result.status,
						attempt,
					},
				);
				break;
			}
			case "retry": {
				const delay = Math.min(
					this.options.retryBaseDelaySeconds * 2 ** Math.max(0, attempt - 1),
					this.options.retryMaxDelaySeconds,
				);
				await this.changeVisibility(message, delay);
				this.metrics.inc("sqs_retries_total");
				this.logger.log("warn", "message_retry_scheduled", {
					messageId: outcome.messageId ?? message.MessageId,
					attempt,
					retryInSeconds: delay,
					reason: outcome.reason.slice(0, 200),
				});
				break;
			}
			case "dead-letter": {
				await this.deadLetter(message, outcome.reason, outcome.detail, attempt);
				this.metrics.inc("sqs_dlq_total", { reason: outcome.reason });
				this.logger.log("error", "message_dead_lettered", {
					messageId: outcome.messageId ?? message.MessageId,
					attempt,
					reason: outcome.reason,
					detail: outcome.detail?.slice(0, 200),
				});
				break;
			}
		}
		this.metrics.observe(
			"message_processing_seconds",
			(performance.now() - startedAt) / 1000,
		);
	}

	private async deadLetter(
		message: Message,
		reason: string,
		detail: string | undefined,
		attempt: number,
	): Promise<void> {
		const group = message.Attributes?.MessageGroupId ?? "dead-letter";
		await this.sqs.send(
			new SendMessageCommand({
				QueueUrl: this.options.dlqUrl,
				MessageBody: message.Body ?? "",
				MessageGroupId: group,
				MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
				MessageAttributes: {
					failureReason: { DataType: "String", StringValue: reason },
					failureDetail: {
						DataType: "String",
						StringValue: (detail ?? "").slice(0, 500) || "-",
					},
					attempts: {
						DataType: "Number",
						StringValue: String(attempt),
					},
					originalMessageId: {
						DataType: "String",
						StringValue: message.MessageId ?? "-",
					},
				},
			}),
		);
		await this.delete(message);
	}

	private async delete(message: Message): Promise<void> {
		await this.sqs.send(
			new DeleteMessageCommand({
				QueueUrl: this.options.queueUrl,
				ReceiptHandle: message.ReceiptHandle,
			}),
		);
	}

	private async changeVisibility(
		message: Message,
		seconds: number,
	): Promise<void> {
		await this.sqs.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: this.options.queueUrl,
				ReceiptHandle: message.ReceiptHandle,
				VisibilityTimeout: seconds,
			}),
		);
	}

	private async release(message: Message): Promise<void> {
		try {
			await this.changeVisibility(message, 0);
		} catch {}
	}
}
