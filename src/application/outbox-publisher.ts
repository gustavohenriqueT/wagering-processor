import { type Logger, silentLogger } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { sleep } from "../observability/sleep";
import type { EventPublisher, UnitOfWork } from "./ports";

export interface OutboxPublisherOptions {
	batchSize: number;
	pollIntervalMs: number;
	baseBackoffMs: number;
	maxBackoffMs: number;
}

export const DEFAULT_OUTBOX_OPTIONS: OutboxPublisherOptions = {
	batchSize: 25,
	pollIntervalMs: 250,
	baseBackoffMs: 1_000,
	maxBackoffMs: 60_000,
};

export interface OutboxRunResult {
	published: number;
	failed: number;
}

export class OutboxPublisher {
	private readonly abort = new AbortController();
	private loop: Promise<void> | undefined;

	constructor(
		private readonly uow: UnitOfWork,
		private readonly publisher: EventPublisher,
		private readonly metrics: Metrics = new Metrics(),
		private readonly logger: Logger = silentLogger,
		private readonly options: OutboxPublisherOptions = DEFAULT_OUTBOX_OPTIONS,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async runOnce(): Promise<OutboxRunResult> {
		const result = await this.uow.run(async ({ outbox }) => {
			const batch = await outbox.claimPending(
				this.clock(),
				this.options.batchSize,
			);
			let published = 0;
			let failed = 0;
			for (const message of batch) {
				try {
					await this.publisher.publish({
						eventId: message.id,
						groupId: message.aggregateId,
						body: JSON.stringify(message.payload),
					});
				} catch (error) {
					message.scheduleRetry(this.clock(), {
						baseMs: this.options.baseBackoffMs,
						maxMs: this.options.maxBackoffMs,
					});
					await outbox.save(message);
					failed += 1;
					this.logger.log("warn", "outbox_publish_failed", {
						eventId: message.id,
						walletId: message.aggregateId,
						eventType: message.eventType,
						attempts: message.attempts,
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}
				message.markPublished(this.clock());
				await outbox.save(message);
				published += 1;
			}
			const lag = await outbox.oldestPendingAgeSeconds();
			return { published, failed, lag: lag ?? 0 };
		});

		if (result.published > 0) {
			this.metrics.inc("outbox_published_total", {}, result.published);
		}
		if (result.failed > 0) {
			this.metrics.inc("outbox_publish_failures_total", {}, result.failed);
		}
		this.metrics.set("outbox_lag_seconds", result.lag);
		return { published: result.published, failed: result.failed };
	}

	start(): void {
		if (this.loop !== undefined) {
			return;
		}
		this.loop = this.run();
	}

	async stop(): Promise<void> {
		this.abort.abort();
		await this.loop;
	}

	private async run(): Promise<void> {
		while (!this.abort.signal.aborted) {
			try {
				const { published, failed } = await this.runOnce();
				if (published + failed < this.options.batchSize) {
					await sleep(this.options.pollIntervalMs, this.abort.signal);
				}
			} catch (error) {
				this.logger.log("error", "outbox_loop_error", {
					error: error instanceof Error ? error.message : String(error),
				});
				await sleep(this.options.pollIntervalMs * 4, this.abort.signal);
			}
		}
	}
}
