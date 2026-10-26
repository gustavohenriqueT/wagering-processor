# Decisões de arquitetura

Rascunho consolidado. Cada decisão: o que escolhi, por quê e o que abri mão (trade-off).
Reescreva com suas palavras: na apresentação, quem explica é você.

## Registro de decisões

### D1. Repositório próprio e privado, sem fork
- **Escolha:** repositório novo e privado em vez de fork. O enunciado fica em `CHALLENGE.md`.
- **Por quê:** o repositório do desafio é público e tem dezenas de forks; fork de repo público é sempre público, expondo a solução.
- **Trade-off:** o avaliador precisa receber acesso (colaborador) ou a visibilidade precisa ser aberta na entrega.

### D2. MiniStack como emulador de SQS
- **Escolha:** `ministackorg/ministack` no lugar do LocalStack.
- **Por quê:** desde março de 2026 a imagem do LocalStack exige conta e auth token. O MiniStack é open source, usa a porta 4566 e o enunciado aceita os dois.
- **Trade-off:** é mais novo; o comportamento de algumas features pode divergir da AWS real. Os testes de integração protegem contra isso.

### D3. PostgreSQL 16 em container, versão fixa
- **Escolha:** `postgres:16-alpine`, volume nomeado e healthcheck com `pg_isready`.
- **Por quê:** reprodutibilidade; os serviços dependentes só iniciam com o banco aceitando conexões.

### D4. Imagem do emulador fixada por digest
- **Escolha:** referenciar o MiniStack por `@sha256:...` em vez de `latest`.
- **Por quê:** `latest` muda com o tempo; o digest identifica a imagem contra a qual os testes rodaram.
- **A fazer:** preencher o digest no `docker-compose.yml` (`docker inspect --format '{{index .RepoDigests 0}}' ministackorg/ministack:latest`).

### D5. Injeção de dependência do NestJS no Bun
- **Observado:** no Bun 1.4.4, a injeção implícita (sem `@Inject`) funcionou no caso simples testado.
- **Escolha:** usar injeção implícita para classes; usar `@Inject(token)` explícito onde o Nest exigir (tokens, interfaces).
- **Risco conhecido:** há relatos de o Bun não aplicar `emitDecoratorMetadata` em alguns cenários. Se a DI falhar em casos mais complexos, passar a usar `@Inject` explícito.

### D6. MikroORM com entidades sem decorators
- **Escolha:** MikroORM (v7) com entidades definidas por arquivos de schema, sem decorators; classes de domínio independentes da persistência.
- **Por quê:** domínio puro (construtor privado e `rehydrate`), menor dependência de metadados no Bun, e separação clara entre domínio, persistência e migrations.
- **Trade-off:** mais verboso que decorators e há código de mapeamento entre domínio e schema.
- **Alternativas:** MikroORM com decorators (reintroduz a dependência de metadados) e TypeORM (exigiria tipo explícito por coluna no Bun).

### D7. Migrations escritas em SQL
- **Escolha:** migrations à mão, em SQL, executadas pelo migrator do MikroORM (`up` e `down`), via `scripts/migrate.ts`.
- **Por quê:** unicidade, imutabilidade e não-negatividade precisam estar no banco; triggers, índices parciais e `CHECK`s aritméticos não são bem expressos por geração automática.
- **Reversibilidade:** o `down()` do MikroORM lança erro por padrão, então cada migration implementa o seu. Verificado: `up`, `down`, `up`. Cada migration roda em transação.
- **Trade-off:** SQL mantido manualmente; o schema pode divergir do mapeamento das entidades. Os testes de integração contra Postgres real protegem.

### D8. Interpretação: uma referência só pode ser revertida uma vez
- **Contexto:** a regra 4 diz "não pode ser revertida duas vezes pelo mesmo tipo"; a tabela diz que `REFUND` e `ROLLBACK` revertem "uma única vez".
- **Interpretação:** uma transação de referência só pode ter **uma** reversão efetivada (`PROCESSED`), seja `REFUND` ou `ROLLBACK`.
- **Motivo:** permitir `REFUND` e `ROLLBACK` sobre a mesma `BET` creditaria o jogador duas vezes.
- **No banco:** índice único parcial `uq_one_processed_reversal` em `wager_transactions (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. Só conta `PROCESSED`, para uma tentativa rejeitada não bloquear a correta.
- **No código:** a violação `23505` deve virar `REJECTED` com `failureCode` próprio, não erro 500.
- **A responder:** por que o `ROLLBACK` de um `REFUND` continua permitido? (qual `reference_transaction_id` ele carrega?)

### D9. `Money` em centavos (`bigint`)
- **Escolha:** inteiro de centavos em `bigint`, sem biblioteca de decimais.
- **Por quê:** aritmética exata (0.10 + 0.20 = 0.30), sem dependência, escala 2 natural. Limite de 17 dígitos inteiros acompanha `numeric(19,2)`.
- **Trade-off:** assume 2 casas para toda moeda (JPY, BHD exigiriam escala por moeda). `Money.from(m.toJSON())` falha para negativos de propósito (negativos são rejeitados em contratos de entrada, mas `subtract`/`negate` podem produzi-los internamente).

### D10. Interpretação: `amount` exige exatamente duas casas decimais
- **Contexto:** o enunciado diz "sempre com escala fixa de 2 casas", mas lista só "mais de 2 casas" entre as inválidas.
- **Interpretação:** exatamente duas casas. `"25"` e `"25.5"` são rejeitados.
- **Motivo:** leitura literal; evita corrigir em silêncio dados inconsistentes de um provedor.
- **Trade-off:** um provedor que envie `"25"` terá a requisição rejeitada.

### D11. `Money.equals` entre moedas diferentes devolve `false`
- `equals` é uma comparação (existe a resposta "não são iguais"). `add`, `subtract` e `isLessThan` entre moedas diferentes lançam `DomainError` (`CURRENCY_MISMATCH`), porque calcular sem câmbio não tem resultado correto.

### D12. Correção do schema: referência opcional fora das reversões
- O enunciado diz que `WIN` pode referenciar a `BET` da rodada. A constraint inicial `ck_reference_required` proibia referência em qualquer tipo que não fosse reversão.
- Corrigido pela migration `Migration20261025000100`: reversões exigem referência; os demais tipos podem ter.

### D13. O domínio não gera ids nem datas
- `id` e `createdAt`/`at` entram por parâmetro; o relógio e o gerador de ids ficam na borda. Torna os testes determinísticos.
- `rehydrate` não revalida: reconstrói o que veio do banco, e `isBalanced()` permite detectar dados corrompidos na reconciliação em vez de falhar ao ler.
- `WalletLedgerEntry` é imutável por tipo (`readonly`) e em tempo de execução (`Object.freeze`).

### D14. `Wallet`: validar tudo antes de mutar
- `debit`/`credit` devolvem o `WalletLedgerEntry`: não há como mudar o saldo sem receber o registro de auditoria.
- A ordem é validar, calcular, criar o lançamento (que valida) e só então atribuir os campos.
- `open` recebe `now` e **não** cria o lançamento de abertura: este é criado pelo caso de uso, junto com a transação `OPENING`, na mesma transação SQL. `version` nasce em 1.
- Saldo insuficiente lança `INSUFFICIENT_FUNDS`; o caso de uso traduz para `failureCode` distinto conforme o contexto (aposta sem saldo vs. reversão que deixaria saldo negativo).
- Valor zero é rejeitado (`INVALID_MOVEMENT_AMOUNT`): `version` só muda quando o saldo muda.

### D15. `WagerTransaction`: transições em tabela
- Transições válidas: `PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED`; `PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED`. `PROCESSED`, `REJECTED` e `FAILED` são terminais.
- `PENDING_REFERENCE -> PENDING_REFERENCE` não é transição: se a referência continua ausente, o worker só atualiza tentativas e agenda a próxima.
- Transição inválida lança `InvalidTransactionStateError` (erro de programação, não caminho de negócio).
- `reject` e `fail` não definem `processedAt` (consistente com `ck_processed_at`).
- `checkReference(reference)` devolve o `FailureCode` ou `undefined`. Ordem das checagens: tipo da referência, contexto (provider, player, wallet, rodada, moeda), status `PROCESSED`, valor igual. A regra "já revertida" depende do banco e fica no caso de uso, sustentada por `uq_one_processed_reversal`.

### D16. Persistência com SQL explícito sobre o MikroORM

- **Escolha:** o MikroORM fornece conexão, transação (`em.transactional`) e migrations; as consultas são SQL explícito via `em.execute`, atrás de interfaces (`ports.ts`) que o caso de uso consome.
- **Por quê:** `SELECT ... FOR UPDATE`, índices parciais e controle exato dos tipos monetários ficam visíveis e revisáveis; o caso de uso nunca depende de SQL.
- **Tipos na fronteira:** `numeric` e `bigint` chegam como string; timestamps são formatados em ISO-8601 pelo próprio SQL; cada coluna é validada ao mapear (falha alta se o tipo for inesperado).
- **Trade-off:** mais código de mapeamento que usar entidades.

### D17. Concorrência: lock pessimista por wallet

- **Escolha:** `SELECT ... FOR UPDATE` na linha da wallet no início de cada transação SQL, mais `UPDATE ... WHERE version = ?` como guarda.
- **Por quê:** a unidade de concorrência é a `walletId`; a segunda operação espera o commit da primeira e lê o saldo atualizado. Wallets diferentes não se bloqueiam, e o lock está no banco, então vale para qualquer número de instâncias. Não depende da ordenação do broker.
- **Trade-off:** uma wallet muito disputada serializa as operações. A alternativa otimista (retry em conflito de `version`) gera tempestade de retries sob disputa alta e dificulta garantir que nenhum retry duplique o débito.
- **Evidência:** teste de integração que mostra a segunda leitura vendo `20.00` com lock e `100.00` sem lock.

### D18. Idempotência e `payloadHash`

- **Algoritmo:** SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (null quando ausente). O header `Idempotency-Key` e metadados de transporte (`correlationId`, `causationId`) ficam de fora.
- **Fluxo:** com o lock da wallet já tomado, busca por `(providerId, idempotencyKey)`. Achou e o hash confere: replay, com o resultado e o saldo **observados na época**. Achou e o hash difere: conflito (`PAYLOAD_MISMATCH`). Mesmo `externalTransactionId` com outra key: conflito (`EXTERNAL_ID_REUSED`).
- **Corrida entre unicidades:** se o `INSERT` perde uma corrida (`23505`), a transação é desfeita e refeita uma vez, enxergando o vencedor como replay ou conflito. O banco é o árbitro final.

### D19. Regras do caso de uso

- Wallet inexistente não persiste transação (a FK exigiria a wallet): é um erro, não uma rejeição auditável.
- Jogador ou moeda diferentes da wallet viram `REJECTED` (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`).
- `LOSS` é processada sem ledger e sem `WalletBalanceChanged`.
- "Referência já revertida" é checada no caso de uso, sob o lock da wallet (`hasProcessedReversal`), e sustentada pelo índice `uq_one_processed_reversal`. O ledger não serve para isso: não registra o que cada lançamento reverte.
- `ROLLBACK` de um `REFUND` é permitido porque referencia o id do `REFUND`, não o da `BET`. Consequência: depois disso a `BET` continua com um estorno processado e não pode ser estornada de novo.
- Evidência de concorrência: o cenário obrigatório (duas apostas de 80 sobre saldo 100), 50 requisições idênticas, 30 e 20 apostas paralelas e estornos simultâneos. Ao remover o `FOR UPDATE`, três desses testes falham.

## Decisões pendentes (exigidas pelo enunciado)

- [ ] Estratégia de concorrência (lock pessimista, otimista ou update atômico) e justificativa
- [ ] Algoritmo do `payloadHash` e forma do JSON canônico
- [ ] Taxonomia final de `failureCode`, com a ação esperada do provedor para cada código
- [ ] Mapeamento de status HTTP
- [ ] Limite ou TTL de `PENDING_REFERENCE` e política de backoff
- [ ] Decisão sobre autenticação
- [ ] Decisão sobre `TRUNCATE` no ledger (trigger atual cobre só `UPDATE`/`DELETE`)

## Limitações conhecidas