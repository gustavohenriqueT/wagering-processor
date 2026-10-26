import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT ck_reference_required;');
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_reference_required
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL);
    `);
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT ck_reference_required;');
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_reference_required
        CHECK ((kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL));
    `);
  }
}
