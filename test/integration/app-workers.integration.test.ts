import "reflect-metadata";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import config from "../../src/infrastructure/database/mikro-orm.config";
import {
	createTestOrm,
	TEST_DATABASE,
	truncateAll,
} from "./support/test-database";
import { createSqsClient, drain, waitFor } from "./support/test-sqs";

setDefaultTimeout(40_000);

let orm: MikroORM;
let sqs: SQSClient;
let app: INestApplication;
let baseUrl: string;
let transactionsUrl: string;
let eventsUrl: string;

beforeAll(async () => {
	orm = await createTestOrm();
	sqs = createSqsClient();
	const suffix = crypto.randomUUID().slice(0, 8);
	app = await NestFactory.create(
		AppModule.forRoot(
			{ ...config, dbName: TEST_DATABASE },
			{
				sqs: {
					region: "us-east-1",
					endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
					accessKeyId: "test",
					secretAccessKey: "test",
				},
				queueNames: {
					transactions: `app-tx-${suffix}.fifo`,
					transactionsDlq: `app-dlq-${suffix}.fifo`,
					events: `app-ev-${suffix}.fifo`,
				},
				visibilityTimeoutSeconds: 2,
				consumer: { waitTimeSeconds: 1, retryBaseDelaySeconds: 1 },
				outbox: { pollIntervalMs: 30 },
			},
		),
		{ logger: false },
	);
	app.enableShutdownHooks();
	await app.listen(0);
	baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

	const urls = await (await import("../../src/messaging/queues")).ensureQueues(
		sqs,
		{
			transactions: `app-tx-${suffix}.fifo`,
			transactionsDlq: `app-dlq-${suffix}.fifo`,
			events: `app-ev-${suffix}.fifo`,
		},
		{ visibilityTimeoutSeconds: 2 },
	);
	transactionsUrl = urls.transactions;
	eventsUrl = urls.events;
});

afterAll(async () => {
	await app?.close();
	await orm?.close();
});

beforeEach(async () => {
	await truncateAll(orm);
});

describe("aplicação completa com os workers ligados", () => {
	test("health/ready checa Postgres e SQS", async () => {
		const response = await fetch(`${baseUrl}/health/ready`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			checks: { postgres: "up", sqs: "up" },
		});
	});

	test("ponta a ponta: HTTP cria a wallet, uma mensagem SQS vira saldo e o evento sai pela outbox", async () => {
		const created = await (
			await fetch(`${baseUrl}/wallets`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					playerId: "player-1",
					initialBalance: { amount: "100.00", currency: "BRL" },
				}),
			})
		).json();

		await sqs.send(
			new SendMessageCommand({
				QueueUrl: transactionsUrl,
				MessageGroupId: created.id,
				MessageDeduplicationId: "msg-1",
				MessageBody: JSON.stringify({
					messageId: "msg-1",
					type: "WagerTransactionRequested",
					occurredAt: new Date().toISOString(),
					data: {
						providerId: "prov-a",
						externalTransactionId: "ext-1",
						idempotencyKey: "prov-a:ext-1",
						playerId: "player-1",
						walletId: created.id,
						roundId: "r1",
						gameId: "g1",
						kind: "BET",
						money: { amount: "30.00", currency: "BRL" },
					},
				}),
			}),
		);

		await waitFor(async () => {
			const wallet = await (
				await fetch(`${baseUrl}/wallets/${created.id}`)
			).json();
			return wallet.balance.amount === "70.00";
		});

		let eventTypes: string[] = [];
		await waitFor(async () => {
			eventTypes = (await drain(sqs, eventsUrl, 1)).map(
				(message) =>
					(JSON.parse(message.Body ?? "{}") as { eventType: string }).eventType,
			);
			return eventTypes.includes("WagerTransactionProcessed");
		});

		const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
		expect(metrics).toContain('sqs_messages_total{outcome="processed"} 1');
		expect(metrics).toContain("outbox_lag_seconds");
		expect(metrics).toContain("message_processing_seconds_count");
	});
});
