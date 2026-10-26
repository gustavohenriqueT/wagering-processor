export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
	correlationId?: string;
	messageId?: string;
	transactionId?: string;
	walletId?: string;
	providerId?: string;
	[extra: string]: string | number | boolean | undefined;
}

export interface Logger {
	log(level: LogLevel, event: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
	constructor(
		private readonly component: string,
		private readonly write: (line: string) => void = (line) =>
			process.stdout.write(`${line}\n`),
	) {}

	log(level: LogLevel, event: string, fields: LogFields = {}): void {
		const entry: Record<string, unknown> = {
			time: new Date().toISOString(),
			level,
			component: this.component,
			event,
		};
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				entry[key] = value;
			}
		}
		this.write(JSON.stringify(entry));
	}
}

export const silentLogger: Logger = { log: () => undefined };
