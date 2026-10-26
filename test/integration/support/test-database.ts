import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../src/infrastructure/database/mikro-orm.config';
import { env } from '../../../src/config/env';

export const TEST_DATABASE = `${env.postgres.database}_test`;

/** Garante que o banco de teste existe, aplica as migrations e devolve uma conexão. */
export async function createTestOrm(): Promise<MikroORM> {
  const admin = await MikroORM.init({ ...config, dbName: 'postgres' });
  try {
    const exists = await admin.em.execute('SELECT 1 AS found FROM pg_database WHERE datname = ?', [
      TEST_DATABASE,
    ]);
    if (exists.length === 0) {
      await admin.em.execute(`CREATE DATABASE "${TEST_DATABASE}"`);
    }
  } finally {
    await admin.close();
  }

  const orm = await MikroORM.init({ ...config, dbName: TEST_DATABASE });
  await orm.migrator.up();
  return orm;
}

/** Limpa todas as tabelas de negócio entre os testes. */
export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em.execute(
    `TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries,
                    wager_transactions, wallets RESTART IDENTITY CASCADE`,
  );
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
