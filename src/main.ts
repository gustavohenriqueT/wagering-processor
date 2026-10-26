import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import config from "./infrastructure/database/mikro-orm.config";
import { messagingOptionsFromEnv } from "./messaging/messaging-options";
import { JsonLogger } from "./observability/logger";
import { NestJsonLogger } from "./observability/nest-json-logger";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(
		AppModule.forRoot(config, messagingOptionsFromEnv()),
		{
			logger: new NestJsonLogger(),
		},
	);
	app.enableShutdownHooks();
	const port = Number(process.env.PORT ?? 3000);
	await app.listen(port);
	new JsonLogger("app").log("info", "listening", { port });
}

void bootstrap();
