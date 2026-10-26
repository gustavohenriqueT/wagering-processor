import {
	CreateQueueCommand,
	GetQueueAttributesCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";

export interface QueueNames {
	transactions: string;
	transactionsDlq: string;
	events: string;
}

export interface QueueUrls {
	transactions: string;
	transactionsDlq: string;
	events: string;
}

export const DEFAULT_QUEUE_NAMES: QueueNames = {
	transactions: "wager-transactions.fifo",
	transactionsDlq: "wager-transactions-dlq.fifo",
	events: "wager-events.fifo",
};

export interface EnsureQueuesOptions {
	visibilityTimeoutSeconds?: number;
	brokerMaxReceiveCount?: number;
}

export async function ensureQueues(
	sqs: SQSClient,
	names: QueueNames = DEFAULT_QUEUE_NAMES,
	options: EnsureQueuesOptions = {},
): Promise<QueueUrls> {
	const visibility = String(options.visibilityTimeoutSeconds ?? 30);
	const maxReceiveCount = options.brokerMaxReceiveCount ?? 10;

	const dlq = await sqs.send(
		new CreateQueueCommand({
			QueueName: names.transactionsDlq,
			Attributes: { FifoQueue: "true" },
		}),
	);
	const dlqAttributes = await sqs.send(
		new GetQueueAttributesCommand({
			QueueUrl: dlq.QueueUrl,
			AttributeNames: ["QueueArn"],
		}),
	);
	const dlqArn = dlqAttributes.Attributes?.QueueArn;
	if (dlq.QueueUrl === undefined || dlqArn === undefined) {
		throw new Error("não foi possível criar a DLQ");
	}

	const transactions = await sqs.send(
		new CreateQueueCommand({
			QueueName: names.transactions,
			Attributes: {
				FifoQueue: "true",
				VisibilityTimeout: visibility,
				RedrivePolicy: JSON.stringify({
					deadLetterTargetArn: dlqArn,
					maxReceiveCount,
				}),
			},
		}),
	);
	const events = await sqs.send(
		new CreateQueueCommand({
			QueueName: names.events,
			Attributes: { FifoQueue: "true" },
		}),
	);
	if (transactions.QueueUrl === undefined || events.QueueUrl === undefined) {
		throw new Error("não foi possível criar as filas");
	}
	return {
		transactions: transactions.QueueUrl,
		transactionsDlq: dlq.QueueUrl,
		events: events.QueueUrl,
	};
}
