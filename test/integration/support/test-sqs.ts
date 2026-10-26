import {
	DeleteMessageCommand,
	type Message,
	ReceiveMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { ensureQueues, type QueueUrls } from "../../../src/messaging/queues";

export function createSqsClient(): SQSClient {
	return new SQSClient({
		region: process.env.AWS_REGION ?? "us-east-1",
		endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
	});
}

export async function createTestQueues(sqs: SQSClient): Promise<QueueUrls> {
	const suffix = crypto.randomUUID().slice(0, 8);
	return ensureQueues(
		sqs,
		{
			transactions: `tx-${suffix}.fifo`,
			transactionsDlq: `tx-dlq-${suffix}.fifo`,
			events: `ev-${suffix}.fifo`,
		},
		{ visibilityTimeoutSeconds: 2 },
	);
}

export async function drain(
	sqs: SQSClient,
	queueUrl: string,
	emptyReadsToStop = 2,
): Promise<Message[]> {
	const collected: Message[] = [];
	let emptyReads = 0;
	while (emptyReads < emptyReadsToStop) {
		const response = await sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 1,
				VisibilityTimeout: 30,
				MessageAttributeNames: ["All"],
				MessageSystemAttributeNames: ["All"],
			}),
		);
		const messages = response.Messages ?? [];
		if (messages.length === 0) {
			emptyReads += 1;
			continue;
		}
		emptyReads = 0;
		for (const message of messages) {
			collected.push(message);
			await sqs.send(
				new DeleteMessageCommand({
					QueueUrl: queueUrl,
					ReceiptHandle: message.ReceiptHandle,
				}),
			);
		}
	}
	return collected;
}

export async function waitFor(
	condition: () => Promise<boolean>,
	{
		timeoutMs = 15_000,
		intervalMs = 100,
	}: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`condição não atendida em ${timeoutMs}ms`);
}
