import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import config from "./infrastructure/database/mikro-orm.config";
import { messagingOptionsFromEnv } from "./messaging/messaging-options";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(
		AppModule.forRoot(config, messagingOptionsFromEnv()),
	);
	app.enableShutdownHooks();
	await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
