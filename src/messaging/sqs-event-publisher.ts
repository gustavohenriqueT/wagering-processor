import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../application/ports";

export class SqsEventPublisher implements EventPublisher {
	constructor(
		private readonly sqs: SQSClient,
		private readonly queueUrl: string,
	) {}

	async publish(message: {
		eventId: string;
		groupId: string;
		body: string;
	}): Promise<void> {
		await this.sqs.send(
			new SendMessageCommand({
				QueueUrl: this.queueUrl,
				MessageBody: message.body,
				MessageGroupId: message.groupId,
				MessageDeduplicationId: message.eventId,
			}),
		);
	}
}
