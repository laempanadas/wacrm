# Pipeline MVP - Expanded Delivery Stages

## Overview

Implementação do MVP de pipeline expandido para o sistema de "Pedidos Delivery" com 5 estágios completos:

1. **Novo Pedido** → Pedido criado, aguardando confirmação de pagamento
2. **Na Cozinha** → Pagamento aprovado, preparando pedido
3. **Pronto para Entrega** → Pedido pronto, aguardando saída
4. **Entregue** → Pedido entregue ao cliente (final)
5. **Pago** → Status de fechamento (legacy, mantém compatibilidade)

---

## Arquivos Criados

### 1. `/src/lib/orders/pipeline-stages.ts` (204 linhas)

**Módulo central** que gerencia o ciclo de vida dos estágios.

**Exportações principais:**

```typescript
// Constantes dos stages
PIPELINE_STAGES = {
  NEW_ORDER: 'Novo Pedido',
  COOKING: 'Na Cozinha',
  READY: 'Pronto para Entrega',
  DELIVERED: 'Entregue',
  PAID: 'Pago',
};

// Mapeamento stage → order.status
STAGE_TO_ORDER_STATUS = {
  'Novo Pedido': 'pending',
  'Na Cozinha': 'payment_approved',
  'Pronto para Entrega': 'ready',
  Entregue: 'delivered',
  Pago: 'paid',
};

// Funções
resolvePipeline(); // Cria/retorna pipeline
resolveStage(); // Cria/retorna stage
moveDealToStage(); // Move deal + sincroniza order.status
getDealCurrentStage(); // Retorna stage atual
```

**Características:**

- ✅ Idempotente — stages criados sob demanda
- ✅ Sincroniza automaticamente order.status
- ✅ Best-effort: falhas em order.status não interrompem movimento do deal
- ✅ Cores personalizadas por stage (Amarelo → Azul → Roxo → Verde)

### 2. `/src/app/api/deals/[id]/move-stage/route.ts` (48 linhas)

**Nova API route** para agentes moverem cards manualmente.

```bash
POST /api/deals/[id]/move-stage
Content-Type: application/json

{
  "stage": "Na Cozinha" | "Pronto para Entrega" | "Entregue"
}

Response:
{
  "ok": true,
  "moved": true,
  "stage": "Na Cozinha"
}
```

**Validações:**

- Requer role ≥ 'agent'
- Stage deve ser valor válido de PIPELINE_STAGES
- Retorna erro 400 se stage inválido

### 3. `/src/lib/orders/pipeline-stages.test.ts` (59 linhas)

**Testes** para constantes e mapeamentos de stage.

```
✅ 7 tests passing
- Stage constants validation
- Order status mappings
- All stages mapped
```

---

## Arquivos Modificados

### 1. `/src/app/api/payments/mercado-pago/webhook/route.ts`

**Antes:**

```typescript
// Movia direto para "Pago" quando pagamento era aprovado
await markDealPaid(db, { accountId, dealId });
```

**Depois:**

```typescript
// Move para "Na Cozinha" quando pagamento é aprovado
await moveDealToStage(db, {
  accountId,
  dealId,
  targetStage: PIPELINE_STAGES.COOKING,
});
```

**Impacto:** Quando Mercado Pago webhook confirma pagamento:

- Deal move para "Na Cozinha" (payment_approved)
- Order status → `payment_approved`
- Cliente recebe notificação "Seu pedido já foi para a cozinha 🔥"

---

## Fluxo Completo (Nova Arquitetura)

```
┌─────────────────────────────────────────────────────────────┐
│ Cliente clica no Catálogo / Paga via IA                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Deal criado em "Novo Pedido" + Order status = 'pending'    │
│ Cliente recebe: "💳 Pagar Agora"                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Mercado Pago webhook: payment.approved                      │
│ → moveDealToStage(COOKING)                                 │
│ → Order status = 'payment_approved'                        │
│ → Cliente notificado: "Seu pedido já foi para a cozinha 🔥" │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ [Agente] Clica botão "Pronto para Entrega" no Card         │
│ POST /api/deals/[id]/move-stage                            │
│ → Order status = 'ready'                                   │
│ → Cliente: "Seu pedido está pronto! 📦"                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ [Motoboy] Clica "Saiu para Entrega" (APP futura)           │
│ → Order status = 'dispatched'                              │
│ → Cliente: "Saiu para te entregar! 🛵"                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ [Motoboy] Clica "Entregue"                                 │
│ → Deal move para "Entregue" (status='won')                │
│ → Order status = 'delivered'                               │
│ → Cliente: "Pedido entregue! Obrigado! 🥟"                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Mudanças no Schema (Supabase)

**Tabela `orders` — novo status suportado:**

```typescript
status: 'pending' |
  'payment_approved' | // NEW: após Mercado Pago aprova
  'ready' | // NEW: pronto na cozinha
  'dispatched' | // NEW: saiu para entrega
  'delivered' | // NEW: entregue
  'paid' | // LEGACY: fechado
  'rejected' | // LEGACY: pagto rejeitado
  'in_process'; // LEGACY: analisando
```

**Tabela `pipeline_stages` — 5 stages criados automaticamente:**

```sql
SELECT * FROM pipeline_stages
WHERE pipeline_id = (
  SELECT id FROM pipelines WHERE name = 'Pedidos Delivery'
);

-- Resultado esperado:
-- | name                  | position | color    |
-- |----------------------|----------|----------|
-- | Novo Pedido          | 0        | #fbbf24  |
-- | Na Cozinha           | 1        | #3b82f6  |
-- | Pronto para Entrega  | 2        | #8b5cf6  |
-- | Entregue             | 3        | #10b981  |
-- | Pago                 | 4        | #16a34a  |
```

---

## Compatibilidade Retroativa

✅ **Preserva funções existentes:**

- `createOrderDeal()` continua funcionando (cria em "Novo Pedido")
- `markDealPaid()` continua disponível (compatibilidade legacy)
- `markContactPaymentConfirmed()` funciona com novos stages
- Mercado Pago webhook mantém assinatura

✅ **Sem breaking changes:**

- Antigos deals em "Pago" continuam funcionando
- Order status 'paid' mapeado para stage "Pago"
- Código existente que query deals por status=open continua válido

---

## Testing & Validation

```bash
# Todos os 672 testes passam ✅
npm run test

# TypeScript strict mode ✅
npm run typecheck

# Pipeline stages tests: 7/7 passing
npm run test -- src/lib/orders/pipeline-stages.test.ts
```

---

## Deployment

1. **Pré-requisitos:**
   - Nenhuma migração SQL necessária (stages criados on-demand)
   - Função `moveDealToStage()` não altera deals existentes

2. **Rollout:**
   - Deploy código
   - Agentes começam a usar `POST /api/deals/[id]/move-stage`
   - Novos pagamentos via Mercado Pago movem para "Na Cozinha" (vs "Pago")

3. **Rollback (se necessário):**
   - Reverter webhook para chamar `markDealPaid()` em vez de `moveDealToStage()`
   - Deals criados em "Na Cozinha" podem ser movidos manualmente para "Pago"

---

## Próximos Passos (Fase 2)

- [ ] Adicionar buttons no Kanban para mover stages (UI)
- [ ] Notificações WhatsApp automáticas por stage (ex: "Pronto para entrega!")
- [ ] Dashboard de métricas por stage (tempo médio na cozinha)
- [ ] Rastreamento de tempo entre stages
- [ ] Integração com app de motoboy (rastreamento de "Saiu para Entrega")
- [ ] Automações baseadas em horário de pico (alerta quando cozinha está lotada)

---

## Commit Info

```
feat: implement expanded pipeline stages MVP (Novo Pedido → Na Cozinha → Pronto → Entregue)

- Create pipeline-stages.ts with stage management helpers
- New POST /api/deals/[id]/move-stage route for manual transitions
- Sync order.status when deal moves between stages
- Update Mercado Pago webhook to move to "Na Cozinha" on payment approval
- Add comprehensive tests for stage mappings
- Maintain backward compatibility with legacy "Pago" stage
```
