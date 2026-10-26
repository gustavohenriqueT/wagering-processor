import { Migration } from "@mikro-orm/migrations";

export class Migration20261026000000 extends Migration {
	override async up(): Promise<void> {
		this.addSql(
			"ALTER TABLE outbox_messages ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;",
		);
		this.addSql("DROP INDEX ix_outbox_pending;");
		this.addSql(
			"CREATE INDEX ix_outbox_pending_seq ON outbox_messages (seq) WHERE published_at IS NULL;",
		);
		this.addSql(
			"CREATE INDEX ix_outbox_pending_aggregate ON outbox_messages (aggregate_id, seq) WHERE published_at IS NULL;",
		);

		this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN pending_attempts integer NOT NULL DEFAULT 0
          CONSTRAINT ck_pending_attempts_non_negative CHECK (pending_attempts >= 0),
        ADD COLUMN next_attempt_at timestamptz;
    `);
		this.addSql(`
      CREATE INDEX ix_tx_pending_reference ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
	}

	override async down(): Promise<void> {
		this.addSql("DROP INDEX IF EXISTS ix_tx_pending_reference;");
		this.addSql(
			"ALTER TABLE wager_transactions DROP COLUMN next_attempt_at, DROP COLUMN pending_attempts;",
		);
		this.addSql("DROP INDEX IF EXISTS ix_outbox_pending_aggregate;");
		this.addSql("DROP INDEX IF EXISTS ix_outbox_pending_seq;");
		this.addSql("ALTER TABLE outbox_messages DROP COLUMN seq;");
		this.addSql(`
      CREATE INDEX ix_outbox_pending ON outbox_messages (occurred_at) WHERE published_at IS NULL;
    `);
	}
}
