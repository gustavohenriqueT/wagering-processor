import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { QueueUrls } from "../messaging/queues";
import { ORM, QUEUE_URLS, SQS_CLIENT } from "./tokens";

export type CheckStatus = "up" | "down";

export interface ReadinessReport {
	status: "ok" | "unavailable";
	checks: Record<string, CheckStatus>;
}

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("timeout")), ms),
		),
	]);
}

@Injectable()
export class ReadinessService {
	constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Optional() @Inject(SQS_CLIENT) private readonly sqs?: SQSClient,
    @Optional() @Inject(QUEUE_URLS) private readonly urls?: QueueUrls,
  ) {}

	async check(): Promise<ReadinessReport> {
		const checks: Record<string, CheckStatus> = {
			postgres: await this.probe(() =>
				this.orm.em.fork().execute("SELECT 1 AS ok"),
			),
		};
		const { sqs, urls } = this;
		if (sqs !== undefined && urls !== undefined) {
			checks.sqs = await this.probe(() =>
				sqs.send(
					new GetQueueAttributesCommand({
						QueueUrl: urls.transactions,
						AttributeNames: ["QueueArn"],
					}),
				),
			);
		}
		const allUp = Object.values(checks).every((status) => status === "up");
		return { status: allUp ? "ok" : "unavailable", checks };
	}

	private async probe(run: () => Promise<unknown>): Promise<CheckStatus> {
		try {
			await withTimeout(run(), CHECK_TIMEOUT_MS);
			return "up";
		} catch {
			return "down";
		}
	}
}
