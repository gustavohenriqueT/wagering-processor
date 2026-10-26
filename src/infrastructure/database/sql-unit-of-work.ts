import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork, UnitOfWorkContext } from "../../application/ports";
import { SqlDb } from "./sql-db";
import {
	SqlInboxRepository,
	SqlLedgerRepository,
	SqlOutboxRepository,
	SqlWagerTransactionRepository,
	SqlWalletRepository,
} from "./sql-repositories";

export class SqlUnitOfWork implements UnitOfWork {
	constructor(private readonly orm: MikroORM) {}

	run<T>(work: (context: UnitOfWorkContext) => Promise<T>): Promise<T> {
		return this.orm.em.fork().transactional(async (em) => {
			const db = new SqlDb(em);
			return work({
				wallets: new SqlWalletRepository(db),
				transactions: new SqlWagerTransactionRepository(db),
				ledger: new SqlLedgerRepository(db),
				outbox: new SqlOutboxRepository(db),
				inbox: new SqlInboxRepository(db),
			});
		});
	}
}
