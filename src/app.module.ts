import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
	type DynamicModule,
	Inject,
	Injectable,
	Module,
	type OnApplicationShutdown,
	type Provider,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ApiExceptionFilter } from "./api/api-exception.filter";
import { Metrics } from "./api/metrics";
import { MetricsController } from "./api/metrics.controller";
import { ReadinessService } from "./api/readiness.service";
import {
	MESSAGING_OPTIONS,
	ORM,
	QUERIES,
	QUEUE_URLS,
	SQS_CLIENT,
	UNIT_OF_WORK,
} from "./api/tokens";
import { TransactionsController } from "./api/transactions.controller";
import { WalletsController } from "./api/wallets.controller";
import { CreateWallet } from "./application/create-wallet";
import type { UnitOfWork } from "./application/ports";
import {
	DEFAULT_PENDING_POLICY,
	ProcessWagerTransaction,
} from "./application/process-wager-transaction";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { SqlQueries } from "./infrastructure/database/sql-queries";
import { SqlUnitOfWork } from "./infrastructure/database/sql-unit-of-work";
import type { MessagingOptions } from "./messaging/messaging-options";
import { DEFAULT_QUEUE_NAMES, ensureQueues } from "./messaging/queues";
import { Workers } from "./messaging/workers";

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
	constructor(@Inject(ORM) private readonly orm: MikroORM) {}

	async onApplicationShutdown(): Promise<void> {
		await this.orm.close();
	}
}

type OrmOptions = Parameters<typeof MikroORM.init>[0];

@Module({})
export class AppModule {
	static forRoot(
		ormOptions: OrmOptions,
		messaging?: MessagingOptions,
	): DynamicModule {
		const messagingProviders: Provider[] =
			messaging === undefined
				? []
				: [
						{ provide: MESSAGING_OPTIONS, useValue: messaging },
						{
							provide: SQS_CLIENT,
							useFactory: () =>
								new SQSClient({
									region: messaging.sqs.region,
									...(messaging.sqs.endpoint === undefined
										? {}
										: { endpoint: messaging.sqs.endpoint }),
									...(messaging.sqs.accessKeyId === undefined ||
									messaging.sqs.secretAccessKey === undefined
										? {}
										: {
												credentials: {
													accessKeyId: messaging.sqs.accessKeyId,
													secretAccessKey: messaging.sqs.secretAccessKey,
												},
											}),
								}),
						},
						{
							provide: QUEUE_URLS,
							useFactory: (sqs: SQSClient) =>
								ensureQueues(sqs, messaging.queueNames ?? DEFAULT_QUEUE_NAMES, {
									...(messaging.visibilityTimeoutSeconds === undefined
										? {}
										: {
												visibilityTimeoutSeconds:
													messaging.visibilityTimeoutSeconds,
											}),
								}),
							inject: [SQS_CLIENT],
						},
						Workers,
					];
		return {
			module: AppModule,
			controllers: [
				HealthController,
				WalletsController,
				TransactionsController,
				MetricsController,
			],
			providers: [
				HealthService,
				ReadinessService,
				Metrics,
				OrmShutdown,
				{ provide: ORM, useFactory: () => MikroORM.init(ormOptions) },
				{
					provide: UNIT_OF_WORK,
					useFactory: (orm: MikroORM) => new SqlUnitOfWork(orm),
					inject: [ORM],
				},
				{
					provide: QUERIES,
					useFactory: (orm: MikroORM) => new SqlQueries(orm),
					inject: [ORM],
				},
				{
					provide: CreateWallet,
					useFactory: (uow: UnitOfWork) => new CreateWallet(uow),
					inject: [UNIT_OF_WORK],
				},
				{
					provide: ProcessWagerTransaction,
					useFactory: (uow: UnitOfWork) =>
						new ProcessWagerTransaction(
							uow,
							() => new Date(),
							() => crypto.randomUUID(),
							{ ...DEFAULT_PENDING_POLICY, ...messaging?.pendingPolicy },
						),
					inject: [UNIT_OF_WORK],
				},
				{ provide: APP_FILTER, useClass: ApiExceptionFilter },
				...messagingProviders,
			],
		};
	}
}
