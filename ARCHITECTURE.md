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

(ainda nao cheguei nessa parte)