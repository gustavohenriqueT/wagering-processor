# Arquitetura e decisões

Este documento registra as decisões do projeto, o motivo de cada uma, o que foi sacrificado em troca (trade-offs) e o que ficou de fora (limitações). Para rodar o projeto, ver o [README.md](./README.md).

## 1. Visão geral

Há três entradas, e todas passam pelo **mesmo caso de uso**:

- a API HTTP (`POST /wagering/transactions`);
- o consumidor SQS (`WagerTransactionRequested`);
- o worker que reprocessa transações em `PENDING_REFERENCE`.

O caso de uso `ProcessWagerTransaction` executa tudo em **uma única transação SQL**:

```
lock da wallet (SELECT ... FOR UPDATE)
  -> inbox (só SQS): registra (consumerName, messageId)
  -> idempotência: replay, conflito ou transação nova
  -> regras de negócio (BET, WIN, LOSS, REFUND, ROLLBACK)
  -> grava: transação + lançamento no ledger + saldo da wallet + eventos na outbox
commit
  -> (depois, em outro processo) o publisher lê a outbox e publica no SQS
```

Se qualquer passo falha, **nada** é gravado. O evento só é publicado **depois** do commit, porque ele vive na outbox, dentro da mesma transação.

**Camadas** (a regra: as dependências apontam para dentro):

- `domain`: regras puras (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`). Não depende de nada.
- `application`: casos de uso e **portas** (interfaces de repositório e de unit of work). Não conhece SQL, framework web nem SDK de fila.
- `infrastructure`: implementa as portas em PostgreSQL.
- `api` e `messaging`: adaptadores de entrada (HTTP e SQS). Um não importa do outro para lógica compartilhada: o parsing da requisição de transação, que HTTP e SQS usam, vive em `application`.

**A regra é imposta por teste**, não só descrita: `src/architecture.test.ts` falha se, por exemplo, o domínio importar a camada de observabilidade, ou se a aplicação importar o NestJS ou um driver de banco ou de fila. Foi verificado plantando violações e conferindo que o teste as acusa pelo nome.

## 2. Ambiente e stack

**Repositório próprio e privado, sem fork.** O repositório do desafio é público e tem dezenas de forks; um fork de repositório público é sempre público e exporia a solução. O enunciado fica em `CHALLENGE.md`. Trade-off: o avaliador precisa receber acesso como colaborador.

**MiniStack no lugar do LocalStack.** Desde março de 2026 a imagem do LocalStack exige conta e auth token para iniciar. O MiniStack é open source, usa a mesma porta (4566) e o enunciado aceita os dois. Trade-off: é mais novo, e o comportamento de algumas funções do SQS pode divergir da AWS real. A imagem está **fixada por digest** no `docker-compose.yml`, para que o resultado não mude entre execuções.

**PostgreSQL 16** (`postgres:16-alpine`), com volume nomeado e healthcheck (`pg_isready`).

**Bun + NestJS + TypeScript estrito** (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`). Observação sobre a injeção de dependência: há relatos de que o Bun nem sempre emite o metadado de tipos dos decorators. No Bun 1.4.4 a injeção implícita funcionou no caso testado, mas os controllers usam `@Inject(...)` explícito por robustez, e as classes de aplicação não têm decorators: são construídas por *factories* no módulo. Isso mantém `application` e `domain` livres de framework.

## 3. Persistência: ORM, `Money` e estratégia transacional

**ORM escolhido: MikroORM (v7)**, o preferencial do enunciado. Na prática, ele é usado como camada de **conexão, transação e migrations**; **não há entidades mapeadas**.

- **Por quê:** o enunciado exige classes de domínio com construtor privado e `rehydrate`. Mapear entidades do ORM sobre elas acoplaria o domínio ao banco, e a abordagem com decorators esbarra no risco do metadado no Bun. Com SQL explícito, `SELECT ... FOR UPDATE`, índices parciais e controle exato dos tipos monetários ficam visíveis e revisáveis. As consultas ficam atrás das portas, então o caso de uso nunca vê SQL.
- **Trade-off:** mais código de mapeamento manual (`rehydrate` a partir das linhas) do que usar entidades.
- **Alternativas descartadas:** MikroORM com decorators (reintroduz a dependência do metadado no Bun) e TypeORM (no Bun exigiria o tipo explícito de cada coluna, e o MikroORM é o preferencial).

**Mapeamento do `Money`.**

| Camada | Representação |
|---|---|
| Banco | `numeric(19,2)` |
| Fronteira com o driver | string (`"70.00"`), sempre com cast explícito (`?::numeric`) |
| Domínio | centavos inteiros em `bigint` |

O valor monetário **nunca** passa por `number`. O driver devolve `numeric` e `bigint` como string, e cada coluna é validada ao mapear (falha alto se o tipo for inesperado). Timestamps saem do banco já em ISO-8601, porque o driver os devolveria como texto no formato do Postgres.

**Estratégia transacional.** Cada caso de uso roda em um *unit of work*: `em.fork().transactional(...)`, com uma conexão própria por unidade de trabalho (sem o `fork`, requisições concorrentes dividiriam a mesma conexão e o lock deixaria de funcionar). Nível de isolamento padrão (`READ COMMITTED`), com **lock explícito de linha** (seção 6). A atomicidade é provada em teste: um erro no meio desfaz transação, ledger, saldo e evento juntos.

**Migrations em SQL, reversíveis.** O `down()` do MikroORM lança erro por padrão, então cada migration implementa o seu. Foram três: o schema inicial, a correção de `ck_reference_required` (seção 5) e a ordem da outbox mais o agendamento do `PENDING_REFERENCE`. A reversibilidade é **verificada por teste automatizado**, num banco descartável: `up`, `up` idempotente, `down` da última e `up`, `down` total (nenhuma tabela, função ou trigger sobra) e `up` de novo. Em cada passo, um retrato completo do schema (colunas, constraints, índices, triggers e funções) é comparado, e o schema reaplicado é idêntico ao original. Cada migration roda em uma transação.

## 4. Modelo de domínio

**`Money`**: centavos em `bigint`. Aritmética inteira é exata (0.10 + 0.20 resulta em 0.30), sem dependência de biblioteca de decimais.
- Entrada **estrita**: exatamente 2 casas decimais, no máximo 17 dígitos inteiros (o limite de `numeric(19,2)`: o domínio rejeita antes de o banco estourar). `"25"`, `"25.5"`, `"1e3"`, `"NaN"`, vazio e negativos são rejeitados; `amount` que não é string também (JSON pode trazer número). Como a entrada com mais de 2 casas é rejeitada, o `Money` não tem operação de arredondamento: não há multiplicação nem divisão que o exija.
- Moedas diferentes: `add`, `subtract` e `isLessThan` lançam `CURRENCY_MISMATCH`; `equals` devolve `false` (é uma pergunta, e "não são iguais" é uma resposta válida).
- `Money.from(m.toJSON())` falha para negativos de propósito (negativos são rejeitados em contratos de entrada), embora `subtract` e `negate` possam produzi-los internamente.
- Trade-off: o modelo assume 2 casas decimais para toda moeda (JPY e BHD exigiriam escala por moeda).

**`Wallet`** (aggregate root): `debit` e `credit` devolvem o `WalletLedgerEntry`, então é impossível mudar o saldo sem receber o registro de auditoria. Valida **tudo antes de mutar**: se algo falha, a wallet continua intacta. Valor zero é rejeitado, para que `version` só mude quando o saldo muda. `open` não cria o lançamento de abertura: quem cria é o caso de uso `CreateWallet`, junto com a transação `OPENING`, na mesma transação SQL.

**`WalletLedgerEntry`**: imutável por tipo (`readonly`) e em tempo de execução (`Object.freeze`). `create` valida (valor positivo, saldos não negativos, `antes ± valor = depois`); `rehydrate` não revalida, o que permite carregar um lançamento corrompido e detectá-lo com `isBalanced()` na reconciliação.

**`WagerTransaction`**: máquina de estados em tabela. Os estados `PROCESSED`, `REJECTED` e `FAILED` são terminais.

| De | Para |
|---|---|
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |

`PENDING_REFERENCE` para `PENDING_REFERENCE` não é transição: se a referência continua ausente, o worker só conta a tentativa e agenda a próxima. Uma transição inválida lança `InvalidTransactionStateError` (erro de programação, nunca um resultado de negócio). `checkReference` aplica as regras de referência nesta ordem, e a ordem define qual código o provedor recebe quando há mais de um problema: tipo da referência, contexto (provedor, jogador, wallet, rodada e moeda), status `PROCESSED`, valor igual.

**`InboxMessage`**: o registro de que um consumidor recebeu uma mensagem. A chave `(consumerName, messageId)` é o que impede o segundo processamento. `receive` valida os campos, `markProcessed` não aceita processar duas vezes nem anteceder o recebimento, e `rehydrate` não revalida.

**`OutboxMessage`**: o evento gravado na mesma transação do fato de negócio, à espera de publicação. `enqueue(evento)` cria uma cópia JSON profunda e imutável do payload (o que é gravado é exatamente o que será publicado). O ciclo de vida é uma máquina de dois estados, pendente e publicado (terminal): `isPending`, `isDue(agora)`, `markPublished` e `scheduleRetry`. O **backoff exponencial limitado** mora na própria classe (`scheduleRetry`), e não no publisher: o publisher só decide quando chamar. Domínio e aplicação continuam desacoplados: a classe só exige que o evento tenha `eventId`, `aggregateId`, `eventType`, `occurredAt` e `toJSON()`.

**O domínio não gera ids nem datas**: eles entram por parâmetro. Isso torna os testes determinísticos e deixa o relógio na borda.

## 5. Schema: invariantes garantidas pelo banco

O enunciado exige que as garantias estejam **no schema**, não só no código. O banco é a última linha de defesa mesmo se o código tiver um bug.

| O que nunca pode acontecer | Mecanismo |
|---|---|
| Saldo negativo | `CHECK ck_wallets_balance_non_negative` |
| Duas wallets do mesmo jogador e moeda | `UNIQUE uq_wallets_player_currency` |
| Mesma transação do provedor registrada duas vezes | `UNIQUE uq_tx_provider_external (provider_id, external_transaction_id)` |
| Mesma `Idempotency-Key` reaproveitada | `UNIQUE uq_tx_idempotency (provider_id, idempotency_key)` |
| Mesma mensagem SQS processada duas vezes | chave primária `(consumer_name, message_id)` na inbox |
| Lançamento do ledger alterado ou apagado | trigger `trg_ledger_immutable` (`UPDATE` e `DELETE`) |
| Lançamento com a conta errada | `CHECK ck_ledger_arithmetic` |
| Mais de um lançamento por wallet e transação | `UNIQUE uq_ledger_wallet_tx` |
| Uma aposta estornada duas vezes | índice único **parcial** `uq_one_processed_reversal` |
| `REFUND` ou `ROLLBACK` sem referência; `REJECTED` sem `failure_code`; `processed_at` inconsistente | `CHECK ck_reference_required`, `ck_failure_code`, `ck_processed_at` |

Todas as constraints que o código precisa distinguir têm **nome estável**: ao receber um erro `23505` (violação de unicidade), o código lê o nome da constraint para decidir o que fazer (conflito de wallet, replay, etc.).

**Cada garantia é testada contra o banco real.** Uma suíte de 28 testes tenta violar cada uma delas e exige que o **banco** recuse, citando a constraint que recusou (inclusive o caso permitido de cada fronteira: saldo zero, o `WIN` com referência, o `ROLLBACK` do `REFUND`, a tentativa `REJECTED` que não bloqueia a reversão correta). Como teste de mutação, derrubamos o trigger do ledger, o índice parcial e o `CHECK` de saldo, um de cada vez, e a suíte falhou exatamente nos testes correspondentes; com o schema restaurado, voltou a passar.

**Correção durante o projeto.** A constraint `ck_reference_required` foi criada proibindo referência em tipos que não fossem reversões, mas o enunciado diz que o `WIN` **pode** referenciar a `BET`. Foi corrigida por uma migration nova: reversões **exigem** referência e os demais tipos **podem** ter.

**`TRUNCATE` no ledger.** O trigger bloqueia `UPDATE` e `DELETE`, mas **não** `TRUNCATE`. Foi uma escolha: os testes de integração precisam limpar as tabelas entre execuções (há um teste que documenta essa decisão). Em produção, a proteção contra `TRUNCATE` ficaria nas permissões do papel da aplicação.

## 6. Concorrência

A unidade de concorrência é a `walletId`.

**Estratégia: lock pessimista por wallet.** Cada transação SQL começa com `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`. A segunda operação espera o commit da primeira e lê o saldo **já atualizado**. Wallets diferentes não se bloqueiam. O lock está no banco, então funciona com qualquer número de instâncias, e não depende da ordenação do broker.

**Uso do `version`.** O enunciado sugere `version` para locking otimista, mas aceita outra estratégia justificada. Aqui o `version` é uma **guarda adicional**: o `UPDATE` é `WHERE id = ? AND version = ?`, e afetar 0 linhas lança erro. Com o `FOR UPDATE` isso nunca deveria disparar; se um dia alguém esquecer o lock, o resultado é um erro explícito, e não um saldo corrompido em silêncio. O `version` também é incrementado a cada mudança de saldo e vai nos eventos.

**Por que não otimista.** Sob disputa alta numa wallet, o locking otimista gera tempestade de retries, e o enunciado exige que nenhum retry duplique o débito, o que é mais simples de garantir com lock.

**Trade-off.** Uma wallet muito disputada **serializa** as operações. É o comportamento desejado para dinheiro, mas limita a vazão por wallet. Para enxergar essa contenção em produção, os conflitos de lock são contados e o tempo de espera é medido (seção 13).

**Corrida entre unicidades.** Se um `INSERT` perde uma corrida de unicidade (por exemplo, a mesma `Idempotency-Key` em wallets diferentes, que não compartilham lock), a transação é desfeita e refeita **uma vez**, e na segunda tentativa enxerga o vencedor como replay ou conflito. O cliente nunca vê um 500 por isso.

**Evidência.** O cenário obrigatório (duas apostas de 80 sobre saldo 100, simultâneas) resulta em exatamente uma `PROCESSED`, uma `REJECTED` por saldo insuficiente, saldo final 20.00 e **um** débito no ledger. Há também testes com 50 requisições idênticas em paralelo, 30 apostas distintas na mesma wallet, 20 apostas disputando o saldo (só 10 passam) e estornos simultâneos da mesma aposta. Como teste de mutação, **removemos o `FOR UPDATE`** e três desses testes falharam; com ele restaurado, passam. Os testes provam que o lock é o que protege.

**Múltiplas instâncias de verdade.** O requisito "correto com várias instâncias" é provado com **processos do sistema operacional** (`Bun.spawn`), cada um com seu pool de conexões: três processos consomem a mesma fila e o mesmo banco; o trabalho é dividido entre eles; e um deles é morto com `SIGKILL` (sem shutdown, sem ack, sem fechar conexões) no meio do trabalho e substituído por outro. No fim, cada mensagem tem **efeito único**, o saldo de cada wallet está correto e igual ao do ledger, e a DLQ está vazia.

## 7. Idempotência

**`payloadHash`**: SHA-256 (hex) de um **JSON canônico** (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`{amount, currency}`) e `referenceExternalTransactionId` (`null` quando ausente). O header `Idempotency-Key` e os metadados de transporte (`correlationId`, `causationId`) **não** entram no hash.

**Fluxo**, já sob o lock da wallet:
1. busca por `(providerId, idempotencyKey)`;
2. achou com o mesmo hash: **replay**, devolvendo o resultado e o saldo **observados na época** da primeira decisão (`idempotentReplay: true`); achou com hash diferente: **conflito** (`PAYLOAD_MISMATCH`, HTTP 409);
3. não achou, mas o `externalTransactionId` já existe com outra key: **conflito** (`EXTERNAL_ID_REUSED`);
4. caso contrário, transação nova.

A idempotência é **persistente** (unicidade no banco), nunca em memória. O replay devolve o mesmo status HTTP da resposta original (por isso uma rejeição repetida continua 422). Para mensagens SQS, a **inbox** é registrada na mesma transação, e a idempotência por chave continua por baixo: duas camadas independentes para o mesmo risco.

## 8. Regras de negócio e interpretações adicionais

O enunciado pede que toda interpretação adicional seja documentada. As adotadas:

- **Uma referência só pode ser revertida uma vez.** A regra 4 fala em "o mesmo tipo", e a tabela diz que `REFUND` e `ROLLBACK` revertem "uma única vez". Interpretação: uma referência admite **uma** reversão efetivada, seja `REFUND` ou `ROLLBACK`. Permitir as duas creditaria o jogador duas vezes. No banco: índice único parcial em `reference_transaction_id` filtrando `status = 'PROCESSED'` e os tipos de reversão. Só conta `PROCESSED`, para que uma tentativa rejeitada (por exemplo, com valor errado) não bloqueie a correta depois.
- **O `ROLLBACK` de um `REFUND` é permitido**, porque referencia o id do `REFUND`, e não o da `BET`. Consequência: depois disso a `BET` continua com um estorno processado e não pode ser estornada de novo.
- **A checagem de "já revertida" é feita no caso de uso**, sob o lock da wallet (`hasProcessedReversal`), e sustentada pelo índice. Não usa o ledger, porque ele não registra o que cada lançamento reverte. Se o índice disparar (`23505`), vira `REJECTED`, nunca 500.
- **Wallet inexistente** não persiste transação (a chave estrangeira exigiria a wallet): é erro 404 (HTTP) ou DLQ (SQS), e não uma rejeição auditável.
- **Jogador ou moeda diferentes dos da wallet** viram `REJECTED` (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`).
- **`LOSS`** é processada sem ledger e sem `WalletBalanceChanged`; aceita valor zero. Os demais tipos exigem valor maior que zero.
- **`WIN` com referência**: a referência é armazenada, mas não resolvida nem validada (o enunciado só diz que ela é opcional).
- **`OPENING`** é interno: a API e o consumidor rejeitam esse tipo.
- **Reversão que deixaria o saldo negativo** é `REVERSAL_WOULD_OVERDRAW`, código **distinto** de `INSUFFICIENT_FUNDS` (aposta sem saldo), porque a situação operacional é outra.

## 9. Referência fora de ordem (`PENDING_REFERENCE`)

Quando a referência não existe, a reversão é aceita como `PENDING_REFERENCE` (HTTP 202) e um worker a reavalia.

**Política** (configurável):

| Parâmetro | Valor padrão |
|---|---|
| Backoff | exponencial, base 2 s, teto 5 min |
| Limite de tentativas | 10 |
| TTL | 1 hora |

**Justificativa.** Com esses valores, o limite de tentativas se esgota em cerca de **18 minutos** (2, 4, 8, 16, 32, 64, 128, 256 e 300 s entre as tentativas), antes do TTL. Reordenação de mensagens costuma durar segundos, então 18 minutos é uma janela generosa, e o TTL de 1 hora é um **teto de segurança**, caso alguém aumente o número de tentativas. Esgotado qualquer um, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e um evento `WagerTransactionRejected` é publicado.

O reprocessamento reutiliza as regras do caso de uso e roda sob o lock da wallet, **relendo** a transação depois do lock (outro worker pode ter decidido antes). Dois workers simultâneos resolvem a pendente uma única vez.

## 10. Taxonomia de `failureCode`

Toda rejeição carrega um código estável. Toda rejeição é **terminal**: não se reenvia a mesma requisição esperando outro resultado.

| Código | Significado | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Aposta maior que o saldo | Desistir desta aposta (ou enviar uma nova, com outro `externalTransactionId`, depois de um crédito) |
| `REVERSAL_WOULD_OVERDRAW` | A reversão deixaria o saldo negativo | Desistir e escalar para operação |
| `REFERENCE_NOT_FOUND` | A referência não chegou dentro do limite de tentativas ou do TTL | Verificar se a transação original foi enviada; reenviar a reversão (novo `externalTransactionId`) depois |
| `REFERENCE_NOT_PROCESSED` | A referência existe, mas não foi processada (por exemplo, foi rejeitada) | Desistir: não há o que reverter |
| `INVALID_REFERENCE_KIND` | `REFUND` só referencia `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND` | Corrigir o payload |
| `REFERENCE_MISMATCH` | Provedor, jogador, wallet, rodada ou moeda diferem da referência | Corrigir o payload |
| `AMOUNT_MISMATCH` | Valor diferente do da referência | Corrigir o payload |
| `ALREADY_REVERSED` | A referência já tem uma reversão efetivada | Desistir: o resultado é final |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir o payload |
| `PLAYER_MISMATCH` | Jogador diferente do dono da wallet | Corrigir o payload |

`FAILED` e `INTERNAL_ERROR` existem no domínio, mas **nenhum fluxo os produz**: uma falha transitória desfaz a transação SQL, não persiste estado, e a requisição pode ser reenviada com a mesma `Idempotency-Key`.

## 11. API HTTP

**Mapeamento de status** (consistente entre todos os endpoints):

| Situação | HTTP | Corpo |
|---|---|---|
| Transação processada (inclusive replay) | 200 | `status: PROCESSED` |
| Wallet criada | 201 | a wallet |
| Aceita, processamento pendente (`PENDING_REFERENCE`) | 202 | `status: PENDING_REFERENCE` |
| Payload ou parâmetro inválido, header ausente, JSON malformado | 400 | `VALIDATION_ERROR` com `details` por campo |
| Wallet, transação ou rota inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` |
| Conflito de idempotência, wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT` (com `reason`), `WALLET_ALREADY_EXISTS` |
| Rejeição por regra de negócio | 422 | `status: REJECTED` + `failureCode` |
| Falha transitória de infraestrutura | 503 + `Retry-After` | `SERVICE_UNAVAILABLE`, `retriable: true` |
| Erro inesperado | 500 | `INTERNAL_ERROR` (sem vazar a mensagem original) |

Todo erro tem o formato `{ "error": { "code", "message", "retriable", "details"? } }`. A regra para o provedor: 4xx não se reenvia igual (corrigir o que está errado); 202 se consulta depois; 5xx se reenvia com a **mesma** `Idempotency-Key` (seguro por idempotência); 422 é um **resultado final**, não um erro. Uma rejeição de negócio é 422 e não 4xx genérico porque o provedor precisa distinguir "o dado está errado" (400) de "o dado está certo e a regra de negócio disse não" (422).

**Outros detalhes.** O header `X-Correlation-Id` é aceito e devolvido em **toda** rota (gerado quando ausente). O cursor do ledger é opaco (base64url de `{"s":"<seq>"}`), ordenado por uma sequência que não empata, e inválido vira 400. A coluna `seq` é um contador `IDENTITY`: tem buracos (valores consumidos por inserts recusados), então serve de ordem, não de contagem.

**Reconciliação.** Compara o saldo guardado com a soma do ledger. Divergências **nunca** são corrigidas em silêncio: geram um log JSON de alerta (`reconciliation_divergence`), o contador `reconciliation_divergences_total` e `consistent: false` na resposta.

## 12. Mensageria

**Consumidor SQS** (`wager-transactions.fifo`, com `MessageGroupId = walletId`):

| Situação | Ação |
|---|---|
| Processada, rejeitada por regra de negócio, `PENDING_REFERENCE` ou duplicata | **ack** (apaga a mensagem, só depois do commit) |
| Falha transitória de infraestrutura ou erro inesperado | **retry**: `ChangeMessageVisibility` com backoff exponencial (2 s, teto 120 s), até 5 tentativas |
| Estourou o limite de tentativas | **DLQ** com `MAX_ATTEMPTS_EXCEEDED` |
| JSON inválido, fora do contrato, validação, wallet inexistente, conflito de idempotência, outros erros de domínio | **DLQ** imediata, com `failureReason`, `failureDetail`, `attempts` e `originalMessageId` |

- A mensagem só é apagada da fila principal **depois** que a DLQ confirma o recebimento: nunca se perde mensagem.
- A `RedrivePolicy` do broker (`maxReceiveCount = 10`) é a rede de segurança para o caso de o worker morrer repetidamente sem registrar a falha.
- **Wallet inexistente é tratada como permanente.** A alternativa seria tentar de novo por um tempo, para o caso de a wallet ainda estar sendo criada.
- A **inbox** (`InboxMessage`) é gravada na mesma transação do processamento (`ON CONFLICT DO NOTHING`): uma entrega duplicada devolve o resultado já gravado, sem novo efeito. Um worker que morre depois do commit e antes do ack faz a mensagem voltar, e a inbox impede o segundo efeito.
- Dentro de um lote, mensagens do mesmo `MessageGroupId` (a wallet) são tratadas em ordem; grupos diferentes correm em paralelo.
- **Encerramento (SIGTERM):** o long poll é abortado, as mensagens em andamento terminam, e as já recebidas mas ainda não iniciadas voltam ao SQS (`VisibilityTimeout = 0`). Os workers param em `beforeApplicationShutdown`, **antes** de o pool de conexões fechar.

**Outbox.** Os eventos são gravados (como `OutboxMessage`) na mesma transação do restante (atomicidade provada em teste). O publisher:
- reserva eventos com `SELECT ... FOR UPDATE SKIP LOCKED`, devolvendo só o **primeiro evento pendente de cada wallet** (pela coluna `seq`), o que preserva a ordem por wallet mesmo com vários publishers;
- publica em `wager-events.fifo`, com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`;
- em caso de falha, a própria `OutboxMessage` agenda a próxima tentativa com backoff exponencial (`scheduleRetry`), e os eventos seguintes daquela wallet esperam;
- se o processo morre depois do commit e antes de publicar (ou depois de publicar e antes de marcar), o lote volta a ficar pendente e **outra instância o publica**. A entrega é **pelo menos uma vez**, e o `eventId` permite deduplicar no broker e no consumidor.

Trade-off: a ordem estrita por wallet limita a vazão a um evento por wallet por rodada do publisher, e uma falha bloqueia os eventos seguintes daquela wallet até o backoff vencer.

**Eventos.** Classe abstrata `IntegrationEvent` com uma subclasse por evento; `eventType` e `version` ficam no tipo. O `data` carrega `MoneyProps` (strings), nunca a instância de `Money`, e é congelado. O `aggregateId` é sempre a `walletId`. `WalletBalanceChanged` só é emitido quando o saldo muda.

## 13. Observabilidade

**Logs.** Toda a aplicação loga em **JSON**: API, consumidor, publisher, workers e os logs internos do Nest. Cada linha tem `time`, `level`, `component` e `event`, mais os campos de correlação `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando existem.

- **Uma linha por requisição HTTP** (`http_request`): método, caminho, rota (o padrão, não o caminho concreto), status e `durationMs`. O nível acompanha o status (2xx e 3xx `info`, 4xx `warn`, 5xx `error`).
- **Sem dados sensíveis:** corpo, query string e valores monetários não entram no log. A **única** exceção é o alerta de divergência de reconciliação (`reconciliation_divergence`), que carrega o saldo guardado, o calculado e a diferença, porque esse é exatamente o dado de diagnóstico que o alerta existe para entregar.
- `/health/*` e `/metrics` são **medidos, mas não geram linha de log** (uma sonda a cada poucos segundos seria ruído).
- Erros 5xx geram `request_failed` com a mensagem original e a stack; a **resposta ao cliente nunca vaza** essa mensagem.

**Correlação.** Um middleware global garante um `X-Correlation-Id` em **toda** rota, inclusive nas inexistentes: o enviado pelo cliente, ou um novo. Ele vai na resposta, nos logs e nos eventos. Para mensagens SQS, o `messageId` faz o papel de `correlationId`; o worker de pendências usa `pending-reference:<id da transação>`.

**Métricas** em `GET /metrics`:

| Métrica | O que mede |
|---|---|
| `http_requests_total{method,route,status}` | requisições por rota (padrão) e status |
| `http_request_duration_seconds{method,route,status}` | histograma da latência HTTP |
| `http_errors_total{status,code}` | erros HTTP por status e código |
| `wager_transactions_total{kind,status,replay}` | transações por tipo e status, **origem HTTP e SQS** |
| `wallet_lock_wait_seconds` | histograma do tempo para obter o lock da wallet |
| `wallet_lock_conflicts_total` | quantas vezes a wallet já estava travada por outra transação |
| `sqs_messages_total{outcome}` | mensagens processadas e duplicatas |
| `duplicates_detected_total{source}` | duplicatas detectadas pela inbox |
| `sqs_retries_total` | retries do consumidor |
| `sqs_dlq_total{reason}` | mensagens enviadas à DLQ, por motivo |
| `message_processing_seconds` | histograma da latência de processamento de mensagens |
| `outbox_published_total`, `outbox_publish_failures_total` | publicação da outbox |
| `outbox_lag_seconds` | idade do evento pendente mais antigo |
| `pending_reference_total{outcome}` | resultado do worker de pendências |
| `reconciliations_total{consistent}`, `reconciliation_divergences_total` | reconciliação |

O rótulo de rota usa o **padrão** (`/wallets/:walletId`), nunca o caminho concreto, para não criar uma série de métricas por wallet (explosão de cardinalidade); rotas inexistentes aparecem como `unmatched`.

**Como o conflito de lock é medido.** Antes do `FOR UPDATE` normal, o código tenta `FOR UPDATE SKIP LOCKED`. Se a linha vem, o lock estava livre. Se não vem, uma segunda consulta distingue "a wallet não existe" de "existe, mas está travada por outra transação"; neste último caso o conflito é contado e só então o código espera pelo lock. É contenção real, sem um limite arbitrário de tempo. O custo é uma consulta extra, e só quando há contenção. O tempo total gasto para obter o lock vai no histograma `wallet_lock_wait_seconds`.

**Health checks** separados: `live` não toca em dependências; `ready` checa PostgreSQL e SQS e devolve 503 se algum estiver fora.

## 14. Autenticação (não implementada)

**Decisão:** não implementar. Autenticação não vale pontos no enunciado, e o tempo foi dedicado a correção financeira, concorrência, idempotência e mensageria.

**Desenho que eu adotaria:** integrar um Identity Provider externo (Keycloak ou Zitadel) por OIDC. O provedor de jogo obtém um token pelo fluxo *client credentials*, e a API valida o JWT (assinatura via JWKS, `iss`, `aud` e expiração). A identidade do provedor vem de uma claim do token e passa a ser verificada contra o `providerId` do corpo. Nada de tabela própria de usuários com senha.

**Ponto de extensão:** `AuthGuard` (`src/api/auth.guard.ts`), registrado como `APP_GUARD` global. Hoje é um no-op. Uma implementação real trocaria o corpo de `canActivate` e manteria `/health/*` e `/metrics` abertos (por exemplo, com um decorador `@Public()`).

**Fora do escopo, como no enunciado:** os endpoints de health ficam abertos, e as mensagens vindas da fila são tratadas como canal interno confiável, mas a identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio.

## 15. Estratégia de testes

- **Unitários (144):** domínio (incluindo `InboxMessage` e `OutboxMessage`), hash, eventos, validação de entrada, mapeamento de erros, filtro de exceções e a regra de dependência entre camadas. Rodam sem Docker.
- **Integração e concorrência (129):** contra PostgreSQL e SQS **reais** (nenhum mock substitui o banco ou a fila; os dublês só injetam falhas, como um banco indisponível ou um `DeleteMessage` que falha uma vez). Cobrem:
  - **constraints do schema** (28 testes): cada garantia é exercitada e o banco precisa recusar a violação (seção 5);
  - **migrations** (5 testes): o ciclo `up`, `down` e `up` num banco descartável, comparando o schema (seção 3);
  - atomicidade, idempotência e replay, o cenário obrigatório de concorrência, conflitos de lock;
  - publishers concorrentes, redelivery, retry com backoff, DLQ, worker morto antes do ack;
  - **múltiplos processos de verdade** (2 testes): 3 processos do sistema operacional sobre o mesmo banco e a mesma fila, e um deles morto com `SIGKILL` (seção 6);
  - a API ponta a ponta, incluindo correlação, latência por padrão de rota e log de acesso (e a ausência de corpo e de valores nele).
- **Determinismo:** o domínio recebe relógio e gerador de ids; as esperas dos testes de SQS e de multiprocesso usam condições (`waitFor`), não pausas fixas; os testes multiprocesso foram repetidos várias vezes para verificar estabilidade.
- **Invariante final** verificada nos cenários financeiros: o saldo da wallet é igual ao saldo reconstruído pelo ledger.
- **Testes de mutação:** remover o `FOR UPDATE` derruba os testes de concorrência; derrubar o trigger do ledger, o índice parcial ou o `CHECK` de saldo derruba os testes de constraints; plantar uma violação de camada derruba o teste de arquitetura. Em todos os casos o teste falhou apontando o defeito, e voltou a passar com o código restaurado.

## 16. Limitações conhecidas

- **Sem teste de carga** (`bun run test:load`), que é opcional no enunciado. Não afirmamos nenhum número de vazão.
- **Entrega de eventos pelo menos uma vez:** os consumidores precisam deduplicar por `eventId`.
- **Vazão por wallet limitada** pelo lock pessimista e pela publicação ordenada da outbox.
- **Os testes multiprocesso rodam em uma máquina só:** os processos são independentes (conexões e memória próprias), mas dividem o mesmo host de PostgreSQL e de SQS. Não há teste com instâncias em hosts diferentes.
- **Os testes de integração usam o MiniStack**; o comportamento de algumas funções do SQS pode divergir da AWS real.
- **Métricas em memória, por instância:** reiniciam com o processo e não são agregadas entre instâncias. Sem OpenTelemetry nem dashboard (opcionais).
- **`wager_transactions_total` não conta as transações resolvidas depois pelo worker de pendências** (esse resultado aparece em `pending_reference_total`).
- **O conflito de lock mede a contenção na entrada da transação** (a espera pelo lock da wallet). Esperas por outros locks do banco, como os de chave estrangeira, não são distinguidas.
- **O app precisa do SQS para subir com os workers ligados** (ele cria as filas na inicialização); sem o SQS, usar `WORKERS_ENABLED=false`.
- **Autenticação não implementada** (seção 14).
- **`TRUNCATE` do ledger não é bloqueado** (seção 5).
