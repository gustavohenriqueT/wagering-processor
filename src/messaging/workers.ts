import type { SQSClient } from "@aws-sdk/client-sqs";
import {
	type BeforeApplicationShutdown,
	Inject,
	Injectable,
	type OnApplicationBootstrap,
} from "@nestjs/common";
import {
	MESSAGING_OPTIONS,
	QUEUE_URLS,
	SQS_CLIENT,
	UNIT_OF_WORK,
} from "../api/tokens";
import {
	DEFAULT_OUTBOX_OPTIONS,
	OutboxPublisher,
} from "../application/outbox-publisher";
import {
	DEFAULT_PENDING_WORKER_OPTIONS,
	PendingReferenceWorker,
} from "../application/pending-reference-worker";
import type { UnitOfWork } from "../application/ports";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { JsonLogger } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import type { MessagingOptions } from "./messaging-options";
import type { QueueUrls } from "./queues";
import { DEFAULT_CONSUMER_OPTIONS, SqsConsumer } from "./sqs-consumer";
import { SqsEventPublisher } from "./sqs-event-publisher";
import { WagerMessageHandler } from "./wager-message-handler";

@Injectable()
export class Workers
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private consumer: SqsConsumer | undefined;
	private outbox: OutboxPublisher | undefined;
	private pending: PendingReferenceWorker | undefined;

	constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ProcessWagerTransaction) private readonly processTransaction: ProcessWagerTransaction,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly urls: QueueUrls,
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingOptions,
  ) {}

	onApplicationBootstrap(): void {
		const logger = new JsonLogger("workers");

		this.consumer = new SqsConsumer(
			this.sqs,
			new WagerMessageHandler(this.processTransaction),
			{
				...DEFAULT_CONSUMER_OPTIONS,
				...this.options.consumer,
				queueUrl: this.urls.transactions,
				dlqUrl: this.urls.transactionsDlq,
			},
			this.metrics,
			new JsonLogger("sqs-consumer"),
		);
		this.consumer.start(this.options.consumerConcurrency ?? 1);

		this.outbox = new OutboxPublisher(
			this.uow,
			new SqsEventPublisher(this.sqs, this.urls.events),
			this.metrics,
			new JsonLogger("outbox-publisher"),
			{ ...DEFAULT_OUTBOX_OPTIONS, ...this.options.outbox },
		);
		this.outbox.start();

		this.pending = new PendingReferenceWorker(
			this.uow,
			this.processTransaction,
			this.metrics,
			new JsonLogger("pending-reference"),
			{ ...DEFAULT_PENDING_WORKER_OPTIONS, ...this.options.pendingWorker },
		);
		this.pending.start();

		logger.log("info", "workers_started");
	}

	async beforeApplicationShutdown(): Promise<void> {
		await Promise.all([
			this.consumer?.stop(),
			this.outbox?.stop(),
			this.pending?.stop(),
		]);
		new JsonLogger("workers").log("info", "workers_stopped");
	}
}
