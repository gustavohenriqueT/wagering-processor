import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'status') {
    console.error('Uso: bun scripts/migrate.ts <up|down|status>');
    process.exit(1);
  }

  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.migrator;
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`Migrations aplicadas: ${applied.length}`);
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`Migrations revertidas: ${reverted.length}`);
    } else {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log(`Executadas: ${executed.length} | Pendentes: ${pending.length}`);
    }
  } finally {
    await orm.close();
  }
}

void main();
