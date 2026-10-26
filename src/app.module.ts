import { MikroORM } from "@mikro-orm/postgresql";
import {
	type DynamicModule,
	Inject,
	Injectable,
	Module,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ApiExceptionFilter } from "./api/api-exception.filter";
import { Metrics } from "./api/metrics";
import { MetricsController } from "./api/metrics.controller";
import { ReadinessService } from "./api/readiness.service";
import { ORM, QUERIES, UNIT_OF_WORK } from "./api/tokens";
import { TransactionsController } from "./api/transactions.controller";
import { WalletsController } from "./api/wallets.controller";
import { CreateWallet } from "./application/create-wallet";
import type { UnitOfWork } from "./application/ports";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { SqlQueries } from "./infrastructure/database/sql-queries";
import { SqlUnitOfWork } from "./infrastructure/database/sql-unit-of-work";

/** Fecha o pool de conexões quando o Nest recebe SIGTERM/SIGINT (enableShutdownHooks). */
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
	/** As opções do ORM entram de fora: a mesma aplicação roda em produção e contra o banco de testes. */
	static forRoot(ormOptions: OrmOptions): DynamicModule {
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
					useFactory: (uow: UnitOfWork) => new ProcessWagerTransaction(uow),
					inject: [UNIT_OF_WORK],
				},
				{ provide: APP_FILTER, useClass: ApiExceptionFilter },
			],
		};
	}
}
