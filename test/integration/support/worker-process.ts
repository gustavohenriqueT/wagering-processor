import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransaction } from "../../../src/application/process-wager-transaction";
import config from "../../../src/infrastructure/database/mikro-orm.config";
import { SqlUnitOfWork } from "../../../src/infrastructure/database/sql-unit-of-work";
import { SqsConsumer } from "../../../src/messaging/sqs-consumer";
import { WagerMessageHandler } from "../../../src/messaging/wager-message-handler";
import { Metrics } from "../../../src/observability/metrics";

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(`variável ${name} ausente`);
	}
	return value;
}

const workerId = required("WORKER_ID");
const orm = await MikroORM.init({
	...config,
	dbName: required("WORKER_DB_NAME"),
});
const sqs = new SQSClient({
	region: "us-east-1",
	endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const useCase = new ProcessWagerTransaction(new SqlUnitOfWork(orm));
const realHandler = new WagerMessageHandler(useCase);

const delayMs = Number(process.env.WORKER_DELAY_MS ?? 0);

const handler = {
	handle: async (...args: Parameters<WagerMessageHandler["handle"]>) => {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		const outcome = await realHandler.handle(...args);
		if (outcome.action === "ack") {
			await orm.em
				.fork()
				.execute(
					"INSERT INTO test_worker_marks (worker_id, message_id) VALUES (?, ?)",
					[workerId, outcome.messageId],
				);
		}
		return outcome;
	},
};

const consumer = new SqsConsumer(
	sqs,
	handler,
	{
		queueUrl: required("WORKER_QUEUE_URL"),
		dlqUrl: required("WORKER_DLQ_URL"),
		maxAttempts: 5,
		waitTimeSeconds: 1,
		maxMessages: 10,
		retryBaseDelaySeconds: 1,
		retryMaxDelaySeconds: 2,
	},
	new Metrics(),
);
consumer.start(1);

await orm.em
	.fork()
	.execute(
		"INSERT INTO test_worker_marks (worker_id, message_id) VALUES (?, ?)",
		[workerId, "__ready__"],
	);

async function shutdown(): Promise<void> {
	await consumer.stop();
	await orm.close();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
