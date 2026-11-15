# Diagnóstico — conversas duplicadas na Caixa de Entrada

Status: correção aplicada no working tree, **não commitada**. Migration 043 criada, **não aplicada**. Script de merge manual criado, **não executado**.

## Sintoma relatado

- A mesma cliente (mesmo telefone) aparece várias vezes na Caixa de Entrada, cada mensagem ou troca em um `conversation_id` diferente.
- Uma conversa com "less than a minute" aparece no meio de conversas com "14 minutes".

## Causas

### 1. Webhook criava conversa nova quando já existiam duas (causa principal)

- Arquivo: `src/app/api/whatsapp/webhook/route.ts` (HEAD), função `findOrCreateConversation`.
- A busca usava `.single()`. Com duas linhas para o mesmo `(account_id, contact_id)`, o PostgREST devolve erro, não a linha. O código tratava erro como "não existe" e inseria outra conversa.
- Cada mensagem seguinte repetia o ciclo, então o número de conversas crescia.

### 2. Mesmo padrão em outros caminhos de criação

- `src/app/api/whatsapp/send/route.ts`, `findOrCreateConversation`: `maybeSingle()` seguido de `insert`. Com duplicatas, `maybeSingle()` devolve `null` e o envio pelo painel inseria mais uma.
- `src/lib/whatsapp/resolve-conversation.ts`, usado pela API pública `/v1/messages`: mesmo padrão.

### 3. Sem constraint no banco

- A tabela `conversations` não tinha índice único em `(account_id, contact_id)`. Duas primeiras mensagens simultâneas (corrida) podiam criar duas conversas.
- A migration `supabase/migrations/043_conversations_account_contact_unique.sql` cria o índice. Ela **falha de propósito** se houver duplicatas.

### 4. Ordenação da Inbox quebrava em tempo real

- Arquivo: `src/app/(dashboard)/inbox/page.tsx`.
- A query inicial ordena por `last_message_at DESC`, mas os handlers de tempo real:
  - atualizam a conversa com `prev.map` (mantém a posição antiga);
  - inserem conversas novas com `[conv, ...prev]` (no topo, independentemente da data).
- Resultado: a lista fica fora de ordem até o próximo refetch.
- Além disso, `DESC` no Postgres coloca `NULL` primeiro. Não estava tratado na query de `src/components/inbox/conversation-list.tsx`.

### Verificado e descartado como causa

- **Telefone com/sem `+`:** `findExistingContact` (`src/lib/contacts/dedupe.ts`) compara pelos últimos 8 dígitos, então formatos diferentes do mesmo número casam com o mesmo contato.
- **`@lid`:** não há tratamento de identificadores `@lid` no código. Isso é risco, não causa do caso relatado (que é de telefone). Precisa de evidência nos logs antes de mudar.

## Correção aplicada

| Arquivo | Mudança |
| --- | --- |
| `src/lib/conversations/find-or-create.ts` (novo) | Helper único: busca a conversa **mais antiga** do contato (`order created_at asc`, `limit 1`); se não existe, insere; se o insert falha com `23505`, relê o vencedor. |
| `src/lib/conversations/find-or-create.test.ts` (novo) | 4 casos: duplicatas existentes, criação, corrida (23505), erro de busca. |
| `src/app/api/whatsapp/webhook/route.ts` | `findOrCreateConversation` delega ao helper. |
| `src/app/api/whatsapp/send/route.ts` | `findOrCreateConversation` delega ao helper. |
| `src/lib/whatsapp/resolve-conversation.ts` | Usa o helper para conversa. |
| `src/lib/whatsapp/resolve-conversation.test.ts` | Mock aceita `order`/`limit`. |
| `src/lib/inbox/sort-conversations.ts` (novo) | Ordena por atividade (`last_message_at` ou `created_at`), desc, desempate por id. |
| `src/lib/inbox/sort-conversations.test.ts` (novo) | 3 casos: ordem por atividade, fallback para `NULL`, sem mutar entrada. |
| `src/app/(dashboard)/inbox/page.tsx` | Todos os `setConversations` que mudam a lista (hydrate, mensagem, conversa INSERT/UPDATE, carga inicial) passam por `sortConversationsByActivity`. |
| `src/components/inbox/conversation-list.tsx` | `.order('last_message_at', { ascending: false, nullsFirst: false })`. |

Validação: Vitest completo verde (121 arquivos, 1920 testes); `tsc --noEmit` ok; ESLint ok nos arquivos alterados. O `npm run lint` global falha só em `scratch/upgrade-467b7ea/` (já existia, não tocado).

## O que ainda não está resolvido

1. **Duplicatas já existentes continuam na Inbox.** A correção impede novas duplicatas e faz todos os caminhos escolherem a conversa mais antiga, mas não consolida as antigas.
2. **Migration 043 não aplicada.** Ela só passa depois de remover as duplicatas.
3. **Merge não executado.** O script manual está em `supabase/manual/merge_duplicate_conversations.sql`. É dry-run por padrão e recusa mesclar quando os dois lados têm carrinho, fluxo ativo ou mensagem com o mesmo `message_id`.
4. **`@lid`** sem tratamento.
5. **Não validado no navegador** nem em banco real.

## Diagnóstico no Supabase (somente leitura)

Quantos contatos têm mais de uma conversa:

```sql
SELECT account_id, contact_id, count(*) AS qtd,
       array_agg(id ORDER BY created_at) AS conversas
FROM public.conversations
GROUP BY account_id, contact_id
HAVING count(*) > 1
ORDER BY qtd DESC;
```

Para a cliente do caso relatado (telefone terminado em `82378636`):

```sql
SELECT c.id, c.created_at, c.last_message_at, c.status,
       ct.phone, ct.name,
       (SELECT count(*) FROM public.messages m WHERE m.conversation_id = c.id) AS mensagens
FROM public.conversations c
JOIN public.contacts ct ON ct.id = c.contact_id
WHERE ct.phone LIKE '%82378636'
ORDER BY c.created_at;
```

Ordem sugerida depois de ler este documento:
1. Rodar os dois SELECTs acima (somente leitura).
2. Rodar o script de merge em modo dry-run e revisar os NOTICEs.
3. Com autorização explícita, executar o merge e depois a migration 043.
4. Commit e push só com autorização.

## Rodada 2 — contatos duplicados (`contact_id` diferentes)

Diagnóstico do Supabase: 5 `contact_id` com 38 conversas duplicadas (um com 17). A conversa `407a3aa0-…` **não** está entre elas: o contato dela tem uma conversa só. Ou seja, a cliente está em mais de um contato, não só em mais de uma conversa.

### Por que contatos se separam

- A migration 022 já colapsou contatos com o mesmo `phone_normalized` (índice único). Duplicatas que sobram diferem nos dígitos.
- A busca no webhook (`findExistingContact`) casa pelos 8 últimos dígitos, então o 9º dígito não cria contato novo na entrada.
- **Causa provável, ainda não confirmada:** a Meta está introduzindo o BSUID (identificador por negócio, ex. `BR.1349…`), que pode vir em `from`. O webhook usava só `from`. Um BSUID vira contato novo, com dígitos que não são telefone.
- Confirmação: query 5 do diagnóstico lê `whatsapp_inbound_receipts.payload` (guarda o payload bruto de cada mensagem).

### Correção aplicada (código)

- `resolveInboundSenderPhone(from, wa_id)` em `src/lib/whatsapp/phone-utils.ts`: usa `from` se for telefone; senão `contacts[].wa_id`; senão mantém o comportamento antigo. Testes em `phone-utils.test.ts` e em `order-routing.test.ts` (BSUID cai no mesmo contato).
- Nenhuma mudança quando `from` já é telefone.

### SQL (em `supabase/manual/`, não são migrations)

| Arquivo | Função |
| --- | --- |
| `diagnostico_contatos_duplicados.sql` | Somente leitura: candidatos, BSUID suspeito, caso da Livia, payloads recebidos. |
| `merge_duplicate_contacts.sql` | Mescla contatos com 12–13 dígitos iguais nos 4 primeiros e 8 últimos. Dry-run por padrão. |
| `merge_duplicate_conversations.sql` | Já existia. Mescla conversas do mesmo contato. Dry-run por padrão. |

**Ordem:** diagnóstico → merge de contatos (dry-run, depois apply) → merge de conversas (dry-run, depois apply) → migration 043.

### Testes do merge de contatos

Testado num Postgres 16 descartável com schema-stub (não é o schema completo do Supabase):
- Dry-run: identificou o par certo e reverteu tudo.
- Apply: removeu o contato perdedor; repontou conversas, notas, rascunho e fluxo ativo; uniu tags repetidas sem violar `UNIQUE`; o valor de campo personalizado do contato mantido prevaleceu; BSUID e contato sem par intactos.
- Aborto: uma tabela nova com FK para `contacts` fez o script abortar, sem alterar dados.

### Pendências do relatório anterior

1. Sabores após carrinho do catálogo: mantido em revisão humana.
2. Carrinho sem fluxo: **já implementado** (`escalateUnroutedNativeCart`: aviso ao cliente, IA pausada, tag e notificação, sem cobrança; testes em `order-routing.test.ts`). Lacuna: se essa chamada lançar exceção, o erro só é logado e o cliente pode ficar sem resposta. Não alterado nesta rodada.
3. `ai_autoreply_disabled`: mantido.

### Pendente

- Rodar o diagnóstico no Supabase e enviar os resultados (principalmente a query 4 e a 5).
- Aplicar merges e migration 043 somente com autorização.
- Commit deixando `scratch/upgrade-467b7ea/` fora.
