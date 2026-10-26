import { describe, expect, test } from "bun:test";
import type { ArgumentsHost } from "@nestjs/common";
import { WalletNotFoundError } from "../application/errors";
import type { LogFields, Logger, LogLevel } from "../observability/logger";
import { ApiExceptionFilter } from "./api-exception.filter";
import { Metrics } from "./metrics";

interface Captured {
	status?: number;
	body?: { error: { code: string; message: string } };
	logs: { level: LogLevel; event: string; fields: LogFields }[];
}

function run(exception: unknown, correlationId?: string): Captured {
	const captured: Captured = { logs: [] };
	const logger: Logger = {
		log: (level, event, fields = {}) =>
			captured.logs.push({ level, event, fields }),
	};
	const response = {
		status: (code: number) => {
			captured.status = code;
		},
		setHeader: () => undefined,
		json: (body: Captured["body"]) => {
			captured.body = body;
		},
	};
	const host = {
		switchToHttp: () => ({
			getResponse: () => response,
			getRequest: () => ({
				headers:
					correlationId === undefined
						? {}
						: { "x-correlation-id": correlationId },
			}),
		}),
	} as unknown as ArgumentsHost;
	new ApiExceptionFilter(new Metrics(), logger).catch(exception, host);
	return captured;
}

describe("ApiExceptionFilter", () => {
	test("erro inesperado: 500 sem vazar a mensagem, e log JSON de erro com o correlationId", () => {
		const result = run(new Error("segredo interno"), "corr-9");
		expect(result.status).toBe(500);
		expect(result.body?.error.message).not.toContain("segredo");
		expect(result.logs).toHaveLength(1);
		expect(result.logs[0]).toMatchObject({
			level: "error",
			event: "request_failed",
			fields: {
				correlationId: "corr-9",
				status: 500,
				code: "INTERNAL_ERROR",
				error: "segredo interno",
			},
		});
	});

	test("erro de cliente (4xx) não gera log de erro", () => {
		const result = run(new WalletNotFoundError("w1"), "corr-1");
		expect(result.status).toBe(404);
		expect(result.logs).toHaveLength(0);
	});

	test("falha transitória: 503 e log de erro", () => {
		const result = run(
			Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
		);
		expect(result.status).toBe(503);
		expect(result.logs[0]?.fields.code).toBe("SERVICE_UNAVAILABLE");
	});
});
