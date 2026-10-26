import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import type { EventPublisher, UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import type { QueueUrls } from '../../src/messaging/queues';
import { SqsEventPublisher } from '../../src/messaging/sqs-event-publisher';
import { Metrics } from '../../src/observability/metrics';
import { SqlUnitOfWork } from '../../src/infrastructure/database/sql-unit-of-work';
import { createSqsClient, createTestQueues, drain } from './support/test-sqs';
import { createTestOrm, truncateAll } from './support/test-database';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const FAST = { batchSize: 50, pollIntervalMs: 20, baseBackoffMs: 60, maxBackoffMs: 200 };

let orm: MikroORM;
let uow: UnitOfWork;
let sqs: SQSClient;
let urls: QueueUrls;
let process: ProcessWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
  orm = await createTestOrm();
  uow = new SqlUnitOfWork(orm);
  sqs = createSqsClient();
  urls = await createTestQueues(sqs);
  process = new ProcessWagerTransaction(uow);
  createWallet = new CreateWallet(uow);
});

afterAll(async () => {
  await orm?.close();
});

beforeEach(async () => {
  await truncateAll(orm);
  await drain(sqs, urls.events, 1);
});

function newPublisher(publisher: EventPublisher = new SqsEventPublisher(sqs, urls.events), unit: UnitOfWork = uow, metrics = new Metrics()) {
  return new OutboxPublisher(unit, publisher, metrics, undefined, FAST);
}

/** Roda o publisher até não haver mais nada a publicar (ele publica só o primeiro evento de cada wallet por rodada). */
async function drainOutbox(publisher: OutboxPublisher, rounds = 60): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const { published, failed } = await publisher.runOnce();
    if (published + failed === 0) {
      const pending = await orm.em.fork().execute('SELECT 1 FROM outbox_messages WHERE published_at IS NULL LIMIT 1');
      if (pending.length === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

async function walletWithBets(playerId: string, bets: number): Promise<string> {
  const wallet = await createWallet.execute({ playerId, initialBalance: brl('1000.00'), correlationId: 'seed' });
  for (let index = 0; index < bets; index += 1) {
    await process.execute({
      providerId: 'prov-a',
      externalTransactionId: `${playerId}-b${index}`,
      idempotencyKey: `prov-a:${playerId}-b${index}`,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: brl('10.00'),
      correlationId: `c-${index}`,
    });
  }
  return wallet.id;
}

async function outboxOrder(): Promise<string[]> {
  const rows = await orm.em.fork().execute('SELECT id FROM outbox_messages ORDER BY seq');
  return (rows as { id: string }[]).map((row) => row.id);
}

function eventIdsOf(messages: { Body?: string }[]): string[] {
  return messages.map((message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId);
}

describe('OutboxPublisher', () => {
  test('publica os eventos na ordem em que foram gravados e marca como publicados', async () => {
    await walletWithBets('p1', 3); // abertura + 3 × (Processed + BalanceChanged) = 7 eventos
    const metrics = new Metrics();
    await drainOutbox(newPublisher(undefined, uow, metrics));

    const expectedOrder = await outboxOrder();
    expect(expectedOrder).toHaveLength(7);
    const published = await orm.em.fork().execute('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NOT NULL');
    expect((published[0] as { n: number }).n).toBe(7);

    const received = eventIdsOf(await drain(sqs, urls.events));
    expect(received).toEqual(expectedOrder);
    expect(metrics.counter('outbox_published_total')).toBe(7);
    expect(metrics.render()).toContain('outbox_lag_seconds 0');
  });

  test('falha ao publicar: reagenda com backoff, mantém a ordem e depois publica', async () => {
    await walletWithBets('p1', 1);
    let failures = 1;
    const flaky: EventPublisher = {
      publish: async (message) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('broker indisponível');
        }
        await new SqsEventPublisher(sqs, urls.events).publish(message);
      },
    };
    const publisher = newPublisher(flaky);

    const first = await publisher.runOnce();
    expect(first).toEqual({ published: 0, failed: 1 });
    const scheduled = await orm.em.fork().execute(
      'SELECT attempts::int AS attempts, next_attempt_at > now() AS in_future FROM outbox_messages WHERE published_at IS NULL ORDER BY seq LIMIT 1',
    );
    expect(scheduled[0]).toMatchObject({ attempts: 1, in_future: true });

    expect(await publisher.runOnce()).toEqual({ published: 0, failed: 0 }); // ainda dentro do backoff
    await new Promise((resolve) => setTimeout(resolve, 150));
    await drainOutbox(publisher);

    const expectedOrder = await outboxOrder();
    expect(eventIdsOf(await drain(sqs, urls.events))).toEqual(expectedOrder);
  });

  test('dois publishers concorrentes sobre a mesma outbox: nada se perde e a ordem por wallet é preservada', async () => {
    const wallets = [await walletWithBets('a', 4), await walletWithBets('b', 4), await walletWithBets('c', 4)];
    await Promise.all([drainOutbox(newPublisher()), drainOutbox(newPublisher())]);

    const received = await drain(sqs, urls.events);
    const ids = eventIdsOf(received);
    expect(new Set(ids).size).toBe(ids.length); // sem duplicatas
    expect(ids).toHaveLength(3 * 9); // (abertura + 4 × 2) por wallet

    for (const walletId of wallets) {
      const rows = await orm.em.fork().execute('SELECT id FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq', [walletId]);
      const expected = (rows as { id: string }[]).map((row) => row.id);
      const seen = received
        .filter((message) => (JSON.parse(message.Body ?? '{}') as { aggregateId: string }).aggregateId === walletId)
        .map((message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId);
      expect(seen).toEqual(expected);
    }
  });

  test('o processo morre depois de publicar e antes do commit: outra instância republica e a duplicata é segura', async () => {
    await walletWithBets('p1', 2);
    const crashingUow: UnitOfWork = {
      run: (work) =>
        uow.run(async (context) => {
          await work(context);
          throw new Error('processo morreu antes do commit');
        }),
    };

    await expect(newPublisher(undefined, crashingUow).runOnce()).rejects.toThrow('processo morreu');
    const stillPending = await orm.em.fork().execute('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL');
    expect((stillPending[0] as { n: number }).n).toBe(5); // nada foi marcado como publicado

    await drainOutbox(newPublisher()); // outra instância assume

    const total = (await outboxOrder()).length;
    const ids = eventIdsOf(await drain(sqs, urls.events));
    expect(new Set(ids).size).toBe(total); // todo evento chegou ao menos uma vez
    expect(ids.length).toBeGreaterThanOrEqual(total); // e uma duplicata, se houver, carrega o mesmo eventId
    const pendingAfter = await orm.em.fork().execute('SELECT 1 FROM outbox_messages WHERE published_at IS NULL');
    expect(pendingAfter).toHaveLength(0);
  });
});
