import { WagerTransactionStatus } from "../domain/wager-transaction";
import { type Logger, silentLogger } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { sleep } from "../observability/sleep";
import type { UnitOfWork } from "./ports";
import type { ProcessWagerTransaction } from "./process-wager-transaction";

export interface PendingReferenceWorkerOptions {
	batchSize: number;
	pollIntervalMs: number;
}

export const DEFAULT_PENDING_WORKER_OPTIONS: PendingReferenceWorkerOptions = {
	batchSize: 25,
	pollIntervalMs: 1_000,
};

export interface PendingRunResult {
	processed: number;
	rejected: number;
	stillPending: number;
	skipped: number;
	failed: number;
}

export class PendingReferenceWorker {
	private readonly abort = new AbortController();
	private loop: Promise<void> | undefined;

	constructor(
		private readonly uow: UnitOfWork,
		private readonly processTransaction: Pick<
			ProcessWagerTransaction,
			"reprocessPending"
		>,
		private readonly metrics: Metrics = new Metrics(),
		private readonly logger: Logger = silentLogger,
		private readonly options: PendingReferenceWorkerOptions = DEFAULT_PENDING_WORKER_OPTIONS,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async runOnce(): Promise<PendingRunResult> {
		const ids = await this.uow.run(({ transactions }) =>
			transactions.listDuePendingReference(
				this.clock(),
				this.options.batchSize,
			),
		);
		const result: PendingRunResult = {
			processed: 0,
			rejected: 0,
			stillPending: 0,
			skipped: 0,
			failed: 0,
		};

		for (const id of ids) {
			try {
				const outcome = await this.processTransaction.reprocessPending(id);
				if (outcome === undefined) {
					result.skipped += 1;
				} else if (outcome.status === WagerTransactionStatus.Processed) {
					result.processed += 1;
				} else if (outcome.status === WagerTransactionStatus.Rejected) {
					result.rejected += 1;
				} else {
					result.stillPending += 1;
				}
			} catch (error) {
				result.failed += 1;
				this.logger.log("error", "pending_reference_failed", {
					transactionId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (const [outcome, count] of Object.entries(result)) {
			if (count > 0) {
				this.metrics.inc("pending_reference_total", { outcome }, count);
			}
		}
		return result;
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
				await this.runOnce();
			} catch (error) {
				this.logger.log("error", "pending_loop_error", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			await sleep(this.options.pollIntervalMs, this.abort.signal);
		}
	}
}
