import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { env } from "../../src/config/env";
import config from "../../src/infrastructure/database/mikro-orm.config";

setDefaultTimeout(60_000);

const SCRATCH = `${env.postgres.database}_migrations`;
const EXPECTED_MIGRATIONS = [
	"Migration20261025000000",
	"Migration20261025000100",
	"Migration20261026000000",
];

let admin: MikroORM;
let orm: MikroORM;

async function recreateScratchDatabase(): Promise<void> {
	await admin.em.execute(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
	await admin.em.execute(`CREATE DATABASE "${SCRATCH}"`);
}

beforeAll(async () => {
	admin = await MikroORM.init({ ...config, dbName: "postgres" });
	await recreateScratchDatabase();
	orm = await MikroORM.init({ ...config, dbName: SCRATCH });
});

afterAll(async () => {
	await orm?.close();
	await admin?.em.execute(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
	await admin?.close();
});

async function schemaSnapshot(): Promise<string> {
	const rows = (await orm.em.fork().execute(`
    SELECT json_build_object(
      'columns', (SELECT json_agg(json_build_array(table_name, column_name, data_type, is_nullable, column_default, is_identity)
                                  ORDER BY table_name, ordinal_position)
                    FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'),
      'constraints', (SELECT json_agg(json_build_array(conrelid::regclass::text, conname, pg_get_constraintdef(oid))
                                      ORDER BY conrelid::regclass::text, conname)
                        FROM pg_constraint
                       WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'mikro_orm_migrations'),
      'indexes', (SELECT json_agg(json_build_array(tablename, indexname, indexdef) ORDER BY tablename, indexname)
                    FROM pg_indexes
                   WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'),
      'triggers', (SELECT json_agg(json_build_array(tgrelid::regclass::text, tgname) ORDER BY tgrelid::regclass::text, tgname)
                     FROM pg_trigger WHERE NOT tgisinternal),
      'functions', (SELECT json_agg(proname ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
    )::text AS snapshot
  `)) as { snapshot: string }[];
	return rows[0]?.snapshot ?? "";
}

async function publicTables(): Promise<string[]> {
	const rows = (await orm.em
		.fork()
		.execute(
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
		)) as { tablename: string }[];
	return rows.map((row) => row.tablename);
}

async function executedNames(): Promise<string[]> {
	return (await orm.migrator.getExecuted()).map((migration) => migration.name);
}

describe("ciclo de vida das migrations (num banco vazio e descartável)", () => {
	let afterFirstUp = "";

	test("up: aplica as 3 migrations, em ordem, e cria o schema", async () => {
		await orm.migrator.up();
		expect(await executedNames()).toEqual(EXPECTED_MIGRATIONS);
		expect(await publicTables()).toEqual([
			"inbox_messages",
			"mikro_orm_migrations",
			"outbox_messages",
			"wager_transactions",
			"wallet_ledger_entries",
			"wallets",
		]);
		afterFirstUp = await schemaSnapshot();
		expect(afterFirstUp).toContain("trg_ledger_immutable");
		expect(afterFirstUp).toContain("uq_one_processed_reversal");
	});

	test("up de novo é idempotente: nada pendente, nada muda", async () => {
		await orm.migrator.up();
		expect(await executedNames()).toEqual(EXPECTED_MIGRATIONS);
		expect(await schemaSnapshot()).toBe(afterFirstUp);
	});

	test("a última migration reverte sozinha e reaplica idêntica", async () => {
		await orm.migrator.down();
		expect(await executedNames()).toEqual(EXPECTED_MIGRATIONS.slice(0, 2));
		const midway = await schemaSnapshot();
		expect(midway).not.toBe(afterFirstUp);
		expect(midway).not.toContain("pending_attempts");
		expect(midway).not.toContain("ix_outbox_pending_seq");

		await orm.migrator.up();
		expect(await executedNames()).toEqual(EXPECTED_MIGRATIONS);
		expect(await schemaSnapshot()).toBe(afterFirstUp);
	});

	test("down total deixa o banco vazio (nenhuma tabela, função ou trigger sobra)", async () => {
		for (
			let guard = 0;
			guard < 10 && (await executedNames()).length > 0;
			guard += 1
		) {
			await orm.migrator.down();
		}
		expect(await executedNames()).toEqual([]);
		expect(await publicTables()).toEqual(["mikro_orm_migrations"]);
		const snapshot = JSON.parse(await schemaSnapshot()) as Record<
			string,
			unknown
		>;
		expect(snapshot.functions).toBeNull();
		expect(snapshot.triggers).toBeNull();
		expect(snapshot.constraints).toBeNull();
	});

	test("reaplicar depois do down total reproduz exatamente o mesmo schema", async () => {
		await orm.migrator.up();
		expect(await executedNames()).toEqual(EXPECTED_MIGRATIONS);
		expect(await schemaSnapshot()).toBe(afterFirstUp);
	});
});
