# Wagering Processor

Solução do desafio técnico da Jungle Gaming: um processador distribuído de transações de apostas, com saldo e ledger corretos sob concorrência, idempotência persistente e mensageria (SQS + transactional outbox).

- Enunciado: [CHALLENGE.md](./CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](./ARCHITECTURE.md)

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Compose v2 (o Docker Desktop precisa estar **aberto**)

## Como rodar

```bash
bun install
cp .env.example .env
docker compose up -d          # PostgreSQL 16 + MiniStack (emulador de SQS)
bun run migrate:up            # aplica as migrations (obrigatório antes do primeiro dev)
bun run dev                   # API em http://localhost:3000 + consumidor SQS + publisher da outbox + worker
```

Verificação rápida:

```bash
curl http://localhost:3000/health/ready      # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para rodar só a API, sem os workers (por exemplo, sem o SQS no ar):

```bash
WORKERS_ENABLED=false bun run dev
```

As filas são criadas automaticamente na inicialização: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com reinício automático (`--watch`) |
| `bun run start` | API sem watch |
| `bun run test` | testes unitários (não precisam de Docker) |
| `bun run test:integration` | testes de integração e concorrência contra PostgreSQL e SQS reais (precisam do Compose no ar; levam cerca de 1 minuto) |
| `bun run test:all` | os dois |
| `bun run typecheck` | checagem de tipos (TypeScript em modo estrito) |
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:status` | quantas migrations foram executadas e quantas estão pendentes |

Os testes de integração usam um banco separado (`<POSTGRES_DB>_test`, criado automaticamente, com as migrations aplicadas) e filas com nome único por execução, então não tocam nos dados de desenvolvimento.

## Variáveis de ambiente

Ver `.env.example`.

| Variável | Para que serve |
|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | conexão com o PostgreSQL |
| `AWS_ENDPOINT_URL` | endpoint do emulador de SQS (`http://localhost:4566`) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | o emulador ignora os valores, mas o SDK exige que existam |
| `PORT` | porta da API (padrão `3000`) |
| `WORKERS_ENABLED` | `false` desliga o consumidor, o publisher e o worker (padrão `true`) |

## API

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | cria a wallet. O saldo inicial vira uma transação `OPENING` e um lançamento `CREDIT` no ledger, na mesma transação SQL |
| `GET /wallets/:walletId` | consulta a wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger paginado por cursor opaco (`limit` de 1 a 200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | compara o saldo guardado com a soma do ledger |
| `POST /wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta pelo id |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live` | o processo está vivo |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis (503 se algum estiver fora) |
| `GET /metrics` | métricas no formato do Prometheus |

Exemplo (use o Git Bash; no PowerShell o `curl` é outro comando):

```bash
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<ID DA WALLET>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Valores monetários são sempre strings com exatamente 2 casas decimais (`"25.00"`).

O mapeamento de status HTTP e o formato dos erros estão na seção 11 do [ARCHITECTURE.md](./ARCHITECTURE.md). Em resumo: `200` processada, `202` pendente de referência, `422` rejeitada por regra de negócio, `400` payload inválido, `404` inexistente, `409` conflito, `503` falha transitória.

## Mensageria

O consumidor lê a fila `wager-transactions.fifo`. Formato da mensagem (o `MessageGroupId` deve ser a `walletId`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-26T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "player-1",
    "walletId": "<ID DA WALLET>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Mensagens com erro permanente (JSON inválido, fora do contrato, wallet inexistente etc.) vão para `wager-transactions-dlq.fifo`, com o motivo nos atributos da mensagem. Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são publicados em `wager-events.fifo` pela outbox.

## Observabilidade

**Logs:** toda a aplicação loga em JSON (API, consumidor SQS, publisher da outbox, workers e os logs internos do framework), uma linha por evento, com `time`, `level`, `component` e `event`, mais `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando existem. Exemplo de uma requisição:

```json
{"time":"2026-10-26T15:29:58.901Z","level":"info","component":"http","event":"http_request","correlationId":"demo-123","method":"POST","path":"/wagering/transactions","route":"/wagering/transactions","status":200,"durationMs":23.32}
```

Corpo, query string e valores monetários não entram no log. `/health/*` e `/metrics` são medidos, mas não geram linha de log.

**Correlação:** todo request recebe um `X-Correlation-Id` (o enviado pelo cliente, ou um novo), devolvido na resposta e presente nos logs.

**Métricas:** `GET /metrics` (formato do Prometheus). A lista completa está na seção 13 do [ARCHITECTURE.md](./ARCHITECTURE.md).

**Health:** `GET /health/live` (processo vivo) e `GET /health/ready` (PostgreSQL e SQS).

## Estrutura

```
src/
  domain/          regras de negócio puras: Money, Wallet, WagerTransaction, ledger
  application/     casos de uso, portas, eventos, publisher da outbox, worker de PENDING_REFERENCE
  infrastructure/  PostgreSQL: repositórios SQL, unit of work, consultas, migrations
  messaging/       consumidor SQS, publisher de eventos, ciclo de vida dos workers
  api/             controllers, validação de entrada, mapeamento de erros, middleware de acesso
  observability/   logs JSON, métricas, utilitários
test/integration/  testes contra PostgreSQL e SQS reais
```

A regra de dependência: `domain` não depende de nada; `application` depende de `domain` e de interfaces (portas); `infrastructure`, `messaging` e `api` são adaptadores.

## Testes

- **Unitários** (`src/**/*.test.ts`, 119 testes): `Money`, `Wallet`, ledger, máquina de estados, hash de payload, eventos, validação de entrada, mapeamento de erros e filtro de exceções.
- **Integração e concorrência** (`test/integration`, 94 testes): migrations e constraints, atomicidade, idempotência e replay, o cenário das duas apostas de 80 sobre saldo 100, 50 requisições idênticas em paralelo, conflitos de lock, publishers concorrentes, redelivery, retry com backoff, DLQ, worker morto antes do ack, 3 consumidores simultâneos, reinício do serviço e a API ponta a ponta (incluindo logs e métricas HTTP).
- A invariante verificada nos testes: o saldo da wallet é igual ao saldo reconstruído pelo ledger.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` ou `:4566` | O Docker Desktop está fechado ou o Compose não está no ar: `docker compose up -d` |
| `column "seq" does not exist` ou `column "next_attempt_at" does not exist` nos logs do `dev` | Há migrations pendentes no banco de desenvolvimento: `bun run migrate:up` (confira com `bun run migrate:status`) |
| `bun test test/integration` diz que não achou arquivos | Use `./test/integration` (já é o que os scripts fazem) |
| O app não sobe e reclama do SQS | O emulador está fora do ar: suba o Compose ou use `WORKERS_ENABLED=false` |