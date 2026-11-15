# Diagnóstico — pedidos do WhatsApp (site / Catálogo Meta / texto livre)

Status: correções aplicadas no working tree, **não commitadas**. Migration 043 criada, **não aplicada** no Supabase.

## Sintoma relatado

Pedido vindo do site ou do Catálogo Meta; na mensagem seguinte o cliente digita os sabores em texto e eles não são processados.

## Causas confirmadas

### 1. Conversas duplicadas (banco + código) — causa mais forte

- `supabase/migrations/*`: a tabela `conversations` não tem índice/constraint único em `(account_id, contact_id)`.
- `src/app/api/whatsapp/webhook/route.ts`, `findOrCreateConversation`: usava `.single()`. Com duas linhas para o mesmo contato o PostgREST devolve erro; a função tratava como "não existe" e criava outra conversa. Cada mensagem seguinte podia repetir isso.
- Consequência: `order_drafts` (UNIQUE em `account_id, conversation_id`), `flow_runs` e o contador da IA são escopados por conversa. O pedido do catálogo e os sabores podem cair em escopos diferentes, e o fluxo ativo não é encontrado.
- Não é possível afirmar que existem duplicatas em produção: não há acesso ao banco nesta sessão.

### 2. Texto livre capturava mensagens interativas, localização e legendas

- `route.ts`, bloco "PEDIDO POR TEXTO LIVRE": a condição era só `!order && contentText`.
- `parseMessageContent` preenche `contentText` com o título de botão/lista, localização e legenda de mídia. Um toque em botão com título "2 carne" abria claim no rascunho de texto em vez de ir para o engine de fluxos.

### 3. IA respondia onde não deveria

- `route.ts`: `shouldAttemptAi = !(order && flowConsumed) && …`. Um carrinho do catálogo não consumido por nenhum fluxo ia para a IA.
- `shouldAttemptAiReply` aceitava `outcome === 'duplicate_inbound_ignored'`. Um retry da Meta já respondido ganhava segunda resposta.

### 4. Parse do carrinho do catálogo

- `unknownIds` podia repetir SKU, e a consulta `getCatalogProductNames` recebia duplicatas.
- `quantity` e `item_price` não eram convertidos com `Number`; valores não numéricos produziam `NaN` no resumo.

## O que foi verificado e considerado correto (não é bug)

- `src/lib/flows/engine.ts`, `dispatchInboundToFlows` / `handleReplyForActiveRun`: texto não reconhecido em `send_buttons` vira `no_match`/fallback. Comportamento intencional.
- `src/lib/orders/text-order-flow.ts`, `processFreeTextOrderInbound`: com carrinho de catálogo ativo (`vars.itens`) e texto com intenção de pedido, a mensagem é preservada para revisão humana (`correctFlowCheckout` + handoff). Isso segue `delivery-core.md` ("Preserve observações para revisão e o carrinho original"). Não é perda silenciosa: o cliente recebe aviso.
- O total do pedido exibido ao cliente vem do catálogo da conta (`groundCatalogOrder` / `grounded.total`), não do total enviado pela Meta.

## Correções aplicadas

`src/app/api/whatsapp/webhook/route.ts`
- Texto livre somente para `message.type === 'text'` e sem `interactiveReplyId`.
- `shouldAttemptAi = !order && shouldAttemptAiReply(…)`.
- `shouldAttemptAiReply`: removido `duplicate_inbound_ignored`.
- `unknownIds` deduplicado; `quantity`/`unit_price` com `Number`; valor não finito mostra "a confirmar" (sem NaN e sem R$ 0,00 falso).
- `findOrCreateConversation`: busca a conversa mais antiga (`order created_at asc`, `limit 1`, `maybeSingle`); em `23505` relê a conversa existente; erro de busca não cria nova conversa.

`src/app/api/whatsapp/webhook/order-routing.test.ts`
- Harness: `limit`/`order` passam a ser honrados; `single`/`maybeSingle` rejeitam mais de uma linha, como o PostgREST.
- 5 testes novos:
  - toque em botão com rascunho existente vai para o engine e não abre claim;
  - carrinho do catálogo não consumido não vai para a IA;
  - duplicado não vai para a IA;
  - com duas conversas, usa a mais antiga;
  - SKU desconhecido consultado uma vez e resumo sem NaN.
- Os 5 falham com o `route.ts` original e passam com a correção.

`supabase/migrations/043_conversations_account_contact_unique.sql` (novo, não aplicado)
- Aborta se houver duplicatas em `(account_id, contact_id)`; senão cria o índice único. Não faz merge.

## Verificação

- Vitest completo: 119 arquivos, 1913 testes passando.
- `npx tsc --noEmit`: sem erros.
- `npx eslint src`: sem erros.
- `npm run lint`: falha apenas por arquivos não rastreados em `scratch/upgrade-467b7ea/` (`require()`), fora do escopo desta mudança.
- Prettier: arquivos alterados limpos. Avisos restantes já existiam no HEAD.

## Pendências e decisões

1. **Sabores após carrinho do catálogo:** hoje vão para revisão humana, não entram no carrinho. Mudar isso é regra de negócio; precisa de confirmação.
2. **Carrinho do catálogo sem fluxo consumidor:** agora não recebe resposta da IA. Se nenhum fluxo consumir o carrinho, o cliente pode ficar sem resposta. Sugestão: handoff explícito nesse caso.
3. **`ai_autoreply_disabled` não é resetado ao reabrir conversa fechada:** não alterado de propósito, para não sobrescrever pausas de atendente.
4. **Migration 043:** antes de aplicar, rodar o diagnóstico abaixo. Se houver duplicatas, a migration aborta e é preciso decidir o merge (mensagens, `order_drafts`, `flow_runs` precisam ser reconciliados).

```sql
SELECT account_id, contact_id, count(*), array_agg(id ORDER BY created_at)
FROM public.conversations
GROUP BY account_id, contact_id
HAVING count(*) > 1;
```

## Ações manuais necessárias

- Aplicar a migration 043 no Supabase **somente com autorização explícita** e após o diagnóstico acima.
- Nenhuma variável de ambiente nova.
- Deploy do código não aplica migration.

## Atualização — rastreio do fluxo de texto (sabores após pedido)

Medido com a suíte de `text-order-flow.test.ts` (sonda temporária, removida depois):

| Cenário | Resultado observado |
|---|---|
| S1 site: "Quero 2 empanadas, entregar Rua Flores, 10 Centro" | `needs_human`; `unresolved = ["2 empanadas"]`; sem cobrança |
| S2 site: seguinte "2 carne e 1 calabresa" | itens entram no carrinho (`meat 2`, `sausage 1`), mas estágio continua `needs_human` |
| S3 site: "confirmo o pedido" | `needs_human`; nenhum pagamento |
| S4 site: "2 carne, 1 calabresa, Rua Flores, 10 Centro" | `confirmation_requested` |
| S5 site: seguinte "+ 1 frango" (fora do catálogo do teste) | `needs_human`; `unresolved = ["1 frango"]` |
| S6 site: "confirmo o pedido" | `needs_human`; nenhum pagamento |
| C1 catálogo ativo + "2 carne, 1 calabresa" | `needs_human`; `flow_checkout_correct` (revisão humana) |
| C2 catálogo ativo + "de frango e ricota" | não tratado pelo texto (vai ao engine de fluxos) |

**Causa:** em `order-draft.ts`, `unresolved` só cresce dentro do rascunho (nada o limpa), e `stage` fica `needs_human` se `previous.stage === 'needs_human'`. Uma linha ambígua ("2 empanadas") transfere para humano e o estágio nunca volta: o cliente não conclui até o pagamento, mesmo mandando os sabores certos. Isso é sticky por desenho (há teste que exige bloqueio), por isso **não alterei**; depende de decisão de produto.

## Atualização — fallback do carrinho do catálogo sem fluxo

- `text-order-flow.ts`: `escalateUnroutedNativeCart` (usa o `handoff` existente, motivo `order_review`, aviso idempotente por episódio, pausa a IA, notifica a equipe; sem cobrança).
- `route.ts`: chamado quando `order && !flowConsumed`. A IA continua excluída desse caminho.
- Teste: `order-routing.test.ts` verifica aviso único, RPC de handoff com `p_request: true`, sem IA e sem pagamento.

## Atualização — merge de duplicatas (script manual)

- `supabase/manual/merge_duplicate_conversations.sql`: **não é migration**. Modo simulação por padrão (`apply := false`, sempre revertido). Aborta se: rascunho nos dois lados do par, rascunho com claim ativo, efeito `sending`/`uncertain`, fluxo `active` nos dois lados, ou mensagem do cliente com o mesmo `message_id` nos dois lados.
- Repontagem genérica de todas as colunas `conversation_id` / `payment_conversation_id` em `public`, com checagem final de referências remanescentes.
- Estado mesclado: pausa da IA preservada (OR), não lidas somadas, `last_message_at` máximo.
- Testado num Postgres descartável com schema-stub (não é a cadeia completa de migrations): dry-run reverte; merge real repontou tudo; 5 abortos funcionaram; 043 aplicou depois do merge e recusou antes dele.

## Pendências atualizadas

1. **Decisão de produto (sticky `unresolved`):** hoje um item ambíguo bloqueia o pedido até um humano. Opções: (a) perguntar o sabor e limpar a pendência quando o cliente responder; (b) manter o bloqueio. Recomendo (a) pela regra do `delivery-core` ("pergunte por sabores ambíguos"), mas exige aprovação e novos testes.
2. Aplicar o merge (só com diagnóstico e aprovação), depois a 043.
