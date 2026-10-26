import type { LoggerService } from "@nestjs/common";
import { JsonLogger } from "./logger";

const QUIET_CONTEXTS = new Set([
	"InstanceLoader",
	"RoutesResolver",
	"RouterExplorer",
	"NestFactory",
	"NestApplication",
]);

export class NestJsonLogger implements LoggerService {
	private readonly json = new JsonLogger("nest");

	log(message: unknown, ...rest: unknown[]): void {
		const context = this.contextOf(rest);
		if (context !== undefined && QUIET_CONTEXTS.has(context)) {
			return;
		}
		this.json.log("info", "nest", { context, message: String(message) });
	}

	warn(message: unknown, ...rest: unknown[]): void {
		this.json.log("warn", "nest", {
			context: this.contextOf(rest),
			message: String(message),
		});
	}

	error(message: unknown, ...rest: unknown[]): void {
		const [stack] = rest;
		this.json.log("error", "nest", {
			context: this.contextOf(rest),
			message: String(message),
			stack:
				typeof stack === "string" && stack.includes("\n") ? stack : undefined,
		});
	}

	private contextOf(rest: unknown[]): string | undefined {
		const last = rest[rest.length - 1];
		return typeof last === "string" && !last.includes("\n") ? last : undefined;
	}
}
