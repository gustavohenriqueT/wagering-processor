import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { DeleteMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet';
import { ProcessWagerTransaction, type ProcessWagerTransactionCommand } from '../../src/application/process-wager-transaction';
import { Money } from '../../src/domain/money';
import type { QueueUrls } from '../../src/messaging/queues';
import { SqsConsumer, type SqsConsumerOptions } from '../../src/messaging/sqs-consumer';
import { WagerMessageHandler } from '../../src/messaging/wager-message-handler';
import { Metrics } from '../../src/observability/metrics';
import { SqlUnitOfWork } from '../../src/infrastructure/database/sql-unit-of-work';
import { createSqsClient, createTestQueues, drain, waitFor } from './support/test-sqs';
import { createTestOrm, truncateAll } from './support/test-database';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

// Retry com backoff e redelivery dependem do relógio do broker: esses testes levam segundos.
setDefaultTimeout(40_000);

let orm: MikroORM;
let sqs: SQSClient;
let urls: QueueUrls;
let useCase: ProcessWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
  orm = await createTestOrm();
  const uow = new SqlUnitOfWork(orm);
  sqs = createSqsClient();
  urls = await createTestQueues(sqs);
  useCase = new ProcessWagerTransaction(uow);
  createWallet = new CreateWallet(uow);
});

afterAll(async () => {
  await orm?.close();
});

beforeEach(async () => {
  await truncateAll(orm);
  await drain(sqs, urls.transactions, 1);
  await drain(sqs, urls.transactionsDlq, 1);
});

const FAST_OPTIONS = (): SqsConsumerOptions => ({
  queueUrl: urls.transactions,
  dlqUrl: urls.transactionsDlq,
  maxAttempts: 3,
  waitTimeSeconds: 1,
  maxMessages: 10,
  retryBaseDelaySeconds: 1,
  retryMaxDelaySeconds: 2,
});

function consumerFor(
  process: Pick<ProcessWagerTransaction, 'execute'> = useCase,
  client: SQSClient = sqs,
  metrics = new Metrics(),
  options: Partial<SqsConsumerOptions> = {},
) {
  return { consumer: new SqsConsumer(client, new WagerMessageHandler(process), { ...FAST_OPTIONS(), ...options }, metrics), metrics };
}

async function newWallet(balance: string, playerId = 'player-1'): Promise<string> {
  return (await createWallet.execute({ playerId, initialBalance: brl(balance), correlationId: 'seed' })).id;
}

function requestBody(walletId: string, messageId: string, amount = '30.00', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-26T15:00:00.000Z',
    data: {
      providerId: 'prov-a',
      externalTransactionId: `ext-${messageId}`,
      idempotencyKey: `prov-a:ext-${messageId}`,
      playerId: 'player-1',
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      ...overrides,
    },
  });
}

async function send(walletId: string, body: string, dedupId: string = crypto.randomUUID()): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: urls.transactions,
      MessageBody: body,
      MessageGroupId: walletId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await orm.em.fork().execute('SELECT balance::text AS balance FROM wallets WHERE id = ?::uuid', [walletId]);
  return (rows[0] as { balance: string }).balance;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await orm.em.fork().execute(sql, params);
  return (rows[0] as { n: number }).n;
}

async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
  const rows = await orm.em.fork().execute(
    `SELECT w.balance = COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = ?::uuid GROUP BY w.balance`,
    [walletId],
  );
  expect((rows[0] as { consistent: boolean }).consistent).toBe(true);
}

describe('processamento básico', () => {
  test('mensagem válida: processada, inbox registrada, fila e DLQ vazias (ack depois do commit)', async () => {
    const walletId = await newWallet('100.00');
    await send(walletId, requestBody(walletId, 'm1'));
    const { consumer, metrics } = consumerFor();
    consumer.start();
    await waitFor(async () => (await balanceOf(walletId)) === '70.00');
    await consumer.stop();

    expect(await count('SELECT count(*)::int AS n FROM inbox_messages')).toBe(1);
    expect(await drain(sqs, urls.transactions, 1)).toHaveLength(0);
    expect(await drain(sqs, urls.transactionsDlq, 1)).toHaveLength(0);
    expect(metrics.counter('sqs_messages_total', { outcome: 'processed' })).toBe(1);
    await expectLedgerMatchesBalance(walletId);
  });

  test('a rejeição de negócio é um resultado: ack, sem DLQ, saldo intacto', async () => {
    const walletId = await newWallet('10.00');
    await send(walletId, requestBody(walletId, 'm1', '500.00'));
    const { consumer } = consumerFor();
    consumer.start();
    await waitFor(async () => (await count("SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'REJECTED'")) === 1);
    await consumer.stop();

    expect(await balanceOf(walletId)).toBe('10.00');
    expect(await drain(sqs, urls.transactionsDlq, 1)).toHaveLength(0);
    expect(await drain(sqs, urls.transactions, 1)).toHaveLength(0);
  });

  test('entrega duplicada (mesmo messageId, reenviada) não duplica o efeito', async () => {
    const walletId = await newWallet('100.00');
    const body = requestBody(walletId, 'm1');
    await send(walletId, body, 'dedup-a');
    await send(walletId, body, 'dedup-b'); // o broker NÃO deduplica (ids diferentes); quem protege é a inbox
    const { consumer, metrics } = consumerFor();
    consumer.start();
    await waitFor(async () => metrics.counter('sqs_messages_total', { outcome: 'duplicate' }) === 1);
    await consumer.stop();

    expect(await balanceOf(walletId)).toBe('70.00');
    expect(await count("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'")).toBe(1);
    expect(metrics.counter('duplicates_detected_total', { source: 'inbox' })).toBe(1);
  });
});

describe('erros permanentes vão direto para a DLQ, com o motivo', () => {
  test('JSON inválido, mensagem fora do contrato, validação e wallet inexistente', async () => {
    const walletId = await newWallet('100.00');
    await send(walletId, 'isto não é json');
    await send(walletId, JSON.stringify({ messageId: 'm2', type: 'Outro', data: {} }));
    await send(walletId, requestBody(walletId, 'm3', '1.5')); // amount com 1 casa
    await send(walletId, requestBody(crypto.randomUUID(), 'm4')); // wallet que não existe
    const { consumer, metrics } = consumerFor();
    consumer.start();
    await waitFor(async () => metrics.counter('sqs_messages_total', { outcome: 'processed' }) + sum(metrics, 'sqs_dlq_total') >= 4, { timeoutMs: 20_000 });
    await consumer.stop();

    const dlq = await drain(sqs, urls.transactionsDlq);
    const reasons = dlq.map((message) => message.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(['INVALID_JSON', 'INVALID_MESSAGE', 'VALIDATION_ERROR', 'WALLET_NOT_FOUND']);
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await drain(sqs, urls.transactions, 1)).toHaveLength(0);
  });
});

function sum(metrics: Metrics, name: string): number {
  return ['INVALID_JSON', 'INVALID_MESSAGE', 'VALIDATION_ERROR', 'WALLET_NOT_FOUND', 'MAX_ATTEMPTS_EXCEEDED']
    .map((reason) => metrics.counter(name, { reason }))
    .reduce((total, value) => total + value, 0);
}

describe('falhas transitórias', () => {
  test('retry com backoff e, quando o banco volta, sucesso sem duplicar efeito', async () => {
    const walletId = await newWallet('100.00');
    let calls = 0;
    const flaky: Pick<ProcessWagerTransaction, 'execute'> = {
      execute: async (command: ProcessWagerTransactionCommand) => {
        calls += 1;
        if (calls <= 2) {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }
        return useCase.execute(command);
      },
    };
    await send(walletId, requestBody(walletId, 'm1'));
    const { consumer, metrics } = consumerFor(flaky, sqs, new Metrics(), { maxAttempts: 5 });
    consumer.start();
    await waitFor(async () => (await balanceOf(walletId)) === '70.00', { timeoutMs: 20_000 });
    await consumer.stop();

    expect(calls).toBe(3);
    expect(metrics.counter('sqs_retries_total')).toBe(2);
    expect(await drain(sqs, urls.transactionsDlq, 1)).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'")).toBe(1);
  });

  test('estourou o limite de tentativas: DLQ com MAX_ATTEMPTS_EXCEEDED', async () => {
    const walletId = await newWallet('100.00');
    const alwaysDown: Pick<ProcessWagerTransaction, 'execute'> = {
      execute: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    };
    await send(walletId, requestBody(walletId, 'm1'));
    const { consumer, metrics } = consumerFor(alwaysDown);
    consumer.start();
    await waitFor(async () => metrics.counter('sqs_dlq_total', { reason: 'MAX_ATTEMPTS_EXCEEDED' }) === 1, { timeoutMs: 25_000 });
    await consumer.stop();

    const dlq = await drain(sqs, urls.transactionsDlq);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(dlq[0]?.MessageAttributes?.attempts?.StringValue).toBe('3');
    expect(metrics.counter('sqs_retries_total')).toBe(2);
    expect(await balanceOf(walletId)).toBe('100.00');
  });
});

describe('redelivery e concorrência', () => {
  test('worker morto depois do commit e antes do ack: a mensagem volta e a inbox impede o segundo efeito', async () => {
    const walletId = await newWallet('100.00');
    let crashed = false;
    class CrashBeforeAck extends SQSClient {
      override async send(command: any, options?: any): Promise<any> {
        if (command instanceof DeleteMessageCommand && !crashed) {
          crashed = true;
          throw new Error('processo morreu antes do ack');
        }
        return super.send(command, options);
      }
    }
    const crashing = new CrashBeforeAck({
      region: 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await send(walletId, requestBody(walletId, 'm1'));
    const { consumer, metrics } = consumerFor(useCase, crashing);
    consumer.start();
    await waitFor(async () => metrics.counter('sqs_messages_total', { outcome: 'duplicate' }) === 1, { timeoutMs: 25_000 });
    await consumer.stop();

    expect(crashed).toBe(true);
    expect(await balanceOf(walletId)).toBe('70.00'); // um único débito, apesar de duas entregas
    expect(await count("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'")).toBe(1);
    expect(await drain(sqs, urls.transactions, 1)).toHaveLength(0);
    await expectLedgerMatchesBalance(walletId);
  });

  test('três consumidores concorrentes, 30 mensagens em 3 wallets: tudo processado exatamente uma vez', async () => {
    const wallets = [await newWallet('100.00', 'a'), await newWallet('100.00', 'b'), await newWallet('100.00', 'c')];
    const players = ['a', 'b', 'c'];
    for (let index = 0; index < 30; index += 1) {
      const wallet = index % 3;
      await send(wallets[wallet] as string, requestBody(wallets[wallet] as string, `m${index}`, '5.00', { playerId: players[wallet] }));
    }
    const instances = [consumerFor(), consumerFor(), consumerFor()];
    for (const { consumer } of instances) {
      consumer.start();
    }
    await waitFor(async () => (await count('SELECT count(*)::int AS n FROM inbox_messages')) === 30, { timeoutMs: 30_000 });
    await Promise.all(instances.map(({ consumer }) => consumer.stop()));

    for (const walletId of wallets) {
      expect(await balanceOf(walletId)).toBe('50.00'); // 10 × 5.00
      await expectLedgerMatchesBalance(walletId);
    }
    expect(await count("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'")).toBe(30);
  });

  test('reinício: o consumidor A para no meio, o B termina, e cada mensagem tem efeito único', async () => {
    const walletId = await newWallet('200.00');
    for (let index = 0; index < 20; index += 1) {
      await send(walletId, requestBody(walletId, `m${index}`, '5.00'));
    }
    const first = consumerFor();
    first.consumer.start();
    await waitFor(async () => (await count('SELECT count(*)::int AS n FROM inbox_messages')) >= 3);
    await first.consumer.stop(); // SIGTERM no meio do trabalho

    const second = consumerFor();
    second.consumer.start();
    await waitFor(async () => (await count('SELECT count(*)::int AS n FROM inbox_messages')) === 20, { timeoutMs: 30_000 });
    await second.consumer.stop();

    expect(await balanceOf(walletId)).toBe('100.00'); // 20 × 5.00 debitados exatamente uma vez
    expect(await count("SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE direction = 'DEBIT'")).toBe(20);
    await expectLedgerMatchesBalance(walletId);
  });

  test('stop() com a fila vazia retorna rápido (o long poll é abortado)', async () => {
    const { consumer } = consumerFor(useCase, sqs, new Metrics(), { waitTimeSeconds: 20 });
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startedAt = Date.now();
    await consumer.stop();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
