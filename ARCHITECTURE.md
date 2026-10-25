# Decisões de arquitetura

Este documento registra as decisões do projeto, o motivo de cada uma e o que foi sacrificado em troca (trade-offs). Ele é atualizado no mesmo dia em que cada decisão é tomada.

## Registro de decisões

### D1. Repositório próprio e privado, sem fork

- **Escolha:** criar um repositório novo, privado, em vez de fazer fork do repositório do desafio.
- **Por quê:** o repositório do desafio é público e já tem dezenas de forks. Um fork de repositório público é sempre público, então a solução ficaria visível para outros candidatos. O enunciado é guardado em `CHALLENGE.md`.
- **Trade-off:** o avaliador precisa receber acesso (colaborador) ou a visibilidade precisa ser aberta na hora da entrega.

### D2. MiniStack como emulador de SQS

- **Escolha:** usar o MiniStack (`ministackorg/ministack`) como emulador local de SQS, no lugar do LocalStack.
- **Por quê:** desde março de 2026 a imagem do LocalStack exige conta e auth token para iniciar. O MiniStack é open source, não exige conta nem token e usa a mesma porta (4566). O enunciado aceita LocalStack ou MiniStack.
- **Trade-off:** o LocalStack é mais completo e mais antigo. O MiniStack é mais novo, então o comportamento de algumas funcionalidades pode divergir da AWS real. Os testes de integração são o que protege contra isso.

### D3. PostgreSQL 16 em container, versão fixa

- **Escolha:** `postgres:16-alpine`, com volume nomeado para persistência e healthcheck com `pg_isready`.
- **Por quê:** versão fixa dá reprodutibilidade (o avaliador roda o mesmo que eu). O healthcheck garante que os serviços dependentes só iniciem quando o banco aceita conexões.
- **Trade-off:** a variante `alpine` é menor, mas usa musl em vez de glibc. Para este projeto isso não tem impacto prático.

### D4. Imagem do emulador fixada por digest

- **Escolha:** referenciar a imagem do MiniStack pelo digest (`@sha256:...`) em vez de `latest`.
- **Por quê:** `latest` muda com o tempo. O digest identifica exatamente a imagem contra a qual os testes foram feitos.
- **Trade-off:** atualizações precisam ser feitas manualmente, o que é aceitável para um projeto de avaliação.

## Decisões pendentes (exigidas pelo enunciado)

Cada item abaixo deve virar uma decisão registrada acima, no mesmo dia em que for tomada. Itens ainda sem decisão devem ficar marcados como pendentes.

- [ ] ORM escolhido (MikroORM ou TypeORM) e como o `Money` é mapeado para o banco
- [ ] Estratégia de concorrência (lock pessimista, otimista ou update atômico) e justificativa
- [ ] Transições de estado válidas de `WagerTransaction`
- [ ] Algoritmo do `payloadHash` e forma do JSON canônico
- [ ] Taxonomia de `failureCode`
- [ ] Mapeamento de status HTTP
- [ ] Limite ou TTL de `PENDING_REFERENCE` e política de backoff
- [ ] Decisão sobre autenticação
- [ ] Interpretações adicionais do enunciado

## Limitações conhecidas

### Dx. Interpretação: uma referência só pode ser revertida uma vez

- **Contexto:** a regra 4 do enunciado diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". A tabela da seção 7 diz que `REFUND` e `ROLLBACK` revertem "uma única vez".
- **Interpretação adotada:** uma transação de referência só pode ter **uma** reversão efetivada (`PROCESSED`), seja `REFUND` ou `ROLLBACK`.
- **Motivo:** permitir um `REFUND` e também um `ROLLBACK` sobre a mesma `BET` creditaria o jogador duas vezes.
- **Como o banco garante:** índice único parcial em `wager_transactions (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. Só conta o status `PROCESSED`, para que uma tentativa rejeitada (por exemplo, com valor diferente) não bloqueie a tentativa correta que vier depois.
- **Consequência no código:** a violação de unicidade (código `23505` do Postgres) deve ser capturada e convertida em `REJECTED` com um `failureCode` próprio, e não virar erro 500.
- **Trade-off:** é uma leitura mais estrita que a regra 4 isolada. Se o provedor precisar de `REFUND` e `ROLLBACK` sobre a mesma aposta, essa regra terá que ser revista.

### Dx. MikroORM com entidades sem decorators

- **Escolha:** usar o MikroORM (v7) com entidades definidas por arquivos de schema, **sem decorators**, mantendo as classes de domínio independentes da camada de persistência.
- **Por quê:**
  - **Domínio puro:** o enunciado exige classes de domínio com construtor privado e método `rehydrate`. Prefiro que elas representem apenas regras de negócio, sem depender de biblioteca de banco de dados. O mapeamento entre domínio e persistência fica em arquivos de schema separados.
  - **Compatibilidade com Bun:** o Bun apenas transpila TypeScript e há relatos de que nem sempre aplica o `emitDecoratorMetadata`. Na injeção de dependência do NestJS, o caso simples funcionou no Bun 1.4.4 nos meus testes, mas evito depender desse mecanismo também na camada de persistência.
  - **Manutenção:** separação clara entre domínio, persistência e migrations, o que deixa o código mais testável e previsível.
- **Trade-off:** definir cada entidade em um arquivo de schema é mais verboso do que anotar a classe com decorators. Também há mais código de mapeamento entre o domínio e o schema.
- **Alternativas consideradas:** MikroORM com decorators (reintroduz a dependência de metadados no Bun) e TypeORM (no Bun exigiria declarar o tipo de cada coluna explicitamente, e o MikroORM é o ORM preferencial do enunciado).

### Dy. Migrations escritas em SQL

- **Escolha:** escrever as migrations à mão, em SQL, executadas pelo migrator do MikroORM (`up` e `down`), e não geradas por diferença de schema.
- **Por quê:** o enunciado exige que unicidade, imutabilidade e não-negatividade estejam no schema do banco. Triggers, índices únicos parciais e `CHECK`s com aritmética não são bem expressos por geração automática. O SQL explícito dá controle total sobre essas garantias e deixa o schema revisável.
- **Reversibilidade:** o `down()` do MikroORM lança erro por padrão, então cada migration implementa o próprio `down()`, desfazendo as mudanças na ordem inversa das dependências. A reversibilidade foi verificada subindo, descendo e subindo de novo. Cada migration roda dentro de uma transação.
- **Trade-off:** o SQL é escrito e mantido manualmente, e o schema pode divergir do mapeamento das entidades se uma das partes for alterada sem a outra. Os testes de integração contra um Postgres real servem de proteção contra isso.

### Dx. Representação interna do `Money`: centavos em `bigint`

- **Escolha:** guardar o valor como inteiro de centavos (`bigint`), em vez de usar uma biblioteca de decimais.
- **Por quê:** a aritmética com inteiros é exata (0.10 + 0.20 resulta em 0.30) e não exige dependência. A escala fixa de 2 casas do enunciado encaixa naturalmente. O limite de 17 dígitos inteiros acompanha a coluna `numeric(19,2)`, para que um valor inválido seja rejeitado pelo domínio e não estoure no banco.
- **Trade-off:** o modelo assume 2 casas decimais para toda moeda. Moedas com 0 ou 3 casas (JPY, BHD) exigiriam escala por moeda. `Money.from(m.toJSON())` falha para valores negativos de propósito, porque negativos são rejeitados em contratos de entrada, embora `subtract` e `negate` possam produzir negativos internamente.

### Dy. Interpretação: `amount` exige exatamente duas casas decimais

- **Contexto:** o enunciado diz que `amount` é recebido "sempre com escala fixa de 2 casas", mas lista só "mais de 2 casas" entre as entradas inválidas.
- **Interpretação adotada:** a entrada exige exatamente duas casas. `"25"` e `"25.5"` são rejeitados, e `"25.00"` é aceito.
- **Motivo:** segue a leitura literal da escala fixa e evita corrigir em silêncio dados financeiros inconsistentes de um provedor.
- **Trade-off:** um provedor que envie `"25"` terá a requisição rejeitada, em vez de tolerada.

### Dz. Interpretação: `equals` entre moedas diferentes devolve `false`

- **Escolha:** `Money.equals` devolve `false` quando as moedas diferem. `add`, `subtract` e `isLessThan` entre moedas diferentes lançam `DomainError` com código `CURRENCY_MISMATCH`.
- **Motivo:** `equals` é uma comparação (a resposta "não são iguais" existe), enquanto as demais são operações que calculam, e calcular entre moedas sem câmbio não tem resultado correto.