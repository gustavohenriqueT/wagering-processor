import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { ORM } from "./tokens";

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
	constructor(@Inject(ORM) private readonly orm: MikroORM) {}

	async check(): Promise<ReadinessReport> {
		const checks: Record<string, CheckStatus> = {
			postgres: await this.probe(() =>
				this.orm.em.fork().execute("SELECT 1 AS ok"),
			),
		};
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
