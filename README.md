# Wagering Processor

Solução do desafio técnico da Jungle Gaming (processador distribuído de transações de apostas).
O enunciado está em [CHALLENGE.md](./CHALLENGE.md). As decisões de arquitetura estão em
[ARCHITECTURE.md](./ARCHITECTURE.md).


## Requisitos

- Bun 1.x
- Docker com Compose v2

## Como rodar

```bash
bun install
cp .env.example .env
docker compose up -d          # Postgres 16 + MiniStack (SQS)
bun run migrate:up            # aplica as migrations
bun run dev                   # sobe a API em http://localhost:3000
```

Verificação rápida: `curl http://localhost:3000/health/live`

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com reinício automático |
| `bun run start` | API sem watch |
| `bun test` | testes |
| `bun run typecheck` | checagem de tipos (TypeScript estrito) |
| `bun run migrate:up` | aplica migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:status` | quantas executadas / pendentes |

## Estado do projeto

- [x] Docker Compose (Postgres + emulador de SQS)
- [x] NestJS + Bun + TypeScript estrito, health `live`
- [x] Schema com constraints e migrations reversíveis
- [x] Domínio: `Money`, `WalletLedgerEntry`, `Wallet`, `WagerTransaction`
- [ ] Caso de uso central (lock por wallet, idempotência, inbox/outbox)
- [ ] API HTTP de negócio
- [ ] Consumidor SQS
- [ ] Outbox publisher e worker de `PENDING_REFERENCE`
- [ ] Testes de integração e concorrência
- [ ] Observabilidade (logs, métricas, `health/ready`)
