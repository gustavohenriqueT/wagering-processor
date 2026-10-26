import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import config from "./infrastructure/database/mikro-orm.config";

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule.forRoot(config));
	app.enableShutdownHooks();
	await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
