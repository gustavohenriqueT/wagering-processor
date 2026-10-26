import type { OutboxPublisherOptions } from "../application/outbox-publisher";
import type { PendingReferenceWorkerOptions } from "../application/pending-reference-worker";
import type { PendingReferencePolicy } from "../application/process-wager-transaction";
import type { QueueNames } from "./queues";
import type { SqsConsumerOptions } from "./sqs-consumer";

export interface MessagingOptions {
	sqs: {
		region: string;
		endpoint?: string;
		accessKeyId?: string;
		secretAccessKey?: string;
	};
	queueNames?: QueueNames;
	visibilityTimeoutSeconds?: number;
	consumerConcurrency?: number;
	consumer?: Partial<Omit<SqsConsumerOptions, "queueUrl" | "dlqUrl">>;
	outbox?: Partial<OutboxPublisherOptions>;
	pendingWorker?: Partial<PendingReferenceWorkerOptions>;
	pendingPolicy?: Partial<PendingReferencePolicy>;
}

export function messagingOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
): MessagingOptions | undefined {
	if (env.WORKERS_ENABLED === "false") {
		return undefined;
	}
	return {
		sqs: {
			region: env.AWS_REGION ?? "us-east-1",
			...(env.AWS_ENDPOINT_URL === undefined
				? {}
				: { endpoint: env.AWS_ENDPOINT_URL }),
			...(env.AWS_ACCESS_KEY_ID === undefined
				? {}
				: { accessKeyId: env.AWS_ACCESS_KEY_ID }),
			...(env.AWS_SECRET_ACCESS_KEY === undefined
				? {}
				: { secretAccessKey: env.AWS_SECRET_ACCESS_KEY }),
		},
	};
}
