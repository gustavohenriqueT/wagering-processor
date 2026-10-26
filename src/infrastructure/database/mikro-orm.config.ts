import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { env } from "../../config/env";

export default defineConfig({
	host: env.postgres.host,
	port: env.postgres.port,
	user: env.postgres.user,
	password: env.postgres.password,
	dbName: env.postgres.database,
	entities: [],
	discovery: { warnWhenNoEntities: false },
	extensions: [Migrator],
	migrations: {
		path: "src/infrastructure/database/migrations",
		pathTs: "src/infrastructure/database/migrations",
		snapshot: false,
	},
});
