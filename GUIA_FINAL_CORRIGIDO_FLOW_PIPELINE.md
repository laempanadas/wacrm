# 🚀 GUIA FINAL CORRIGIDO: Implementar Flow → Pipeline Automático
## Versão Validada (Sem HTTP, Com validate.ts, Com Imports)

---

## ✅ Status Final
- ✅ Banco: Migration 032 com `set_var` + `custom_action` (+ `send_media` preservado)
- ✅ Tipos: `CustomActionNodeConfig` + `SetVarNodeConfig` com `value: string`
- ✅ Engine: `executeCustomAction` chamando `createOrderDeal` **direto** (sem HTTP)
- ✅ validate.ts: Reconhece `set_var` + `custom_action` + outgoingEdges
- ✅ Flow: Nó `custom_action` integrado antes do handoff

---

# PASSO 0: Migration 032 (Banco de Dados)

## 📁 Arquivo: `supabase/migrations/032_flow_set_var_custom_action.sql`

**Criar novo arquivo com:**

```sql
-- ============================================================
-- 032_flow_set_var_custom_action.sql
--
-- Flows: add 'set_var' and 'custom_action' node types.
--
-- Enables the La Empanadas ordering flow to:
--   1. set_var: persist button/list choices into flow_runs.vars
--   2. custom_action: trigger the pipeline deal creation
--
-- The node_type CHECK was created in migration 016 and widened
-- in 016 for send_media. We drop and re-add it with the two new
-- values, preserving all existing types.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',         -- From 016: preserved ✅
    'collect_input',
    'condition',
    'set_tag',
    'set_var',            -- NEW: persist value into flow_runs.vars
    'custom_action',      -- NEW: create_order_deal / future actions
    'handoff',
    'http_fetch',
    'end'
  ));
```

---

# PASSO 1: Tipos TypeScript

## 📁 Arquivo: `src/lib/flows/types.ts`

### 1.1 Encontre os tipos existentes

Procure por:
```typescript
export interface SendMessageNodeConfig {
  text: string;
  next_node_key: string;
  // ...
}
```

### 1.2 Adicione ANTES de `HandoffNodeConfig`:

```typescript
export interface SetVarNodeConfig {
  /**
   * Persist a value into flow_runs.vars.
   * value supports {{vars.X}} interpolation via interpolateVars().
   */
  var_key: string;
  value: string;  // Interpolable — e.g., "{{reply_id}}" for button ID
  next_node_key: string;
}

export interface CustomActionNodeConfig {
  /**
   * Execute a custom action. Supported:
   *   - 'create_order_deal': Creates an order in the pipeline
   */
  action: 'create_order_deal';
  next_node_key: string;
}
```

---

# PASSO 2: Flow Engine

## 📁 Arquivo: `src/lib/flows/engine.ts`

### 2.1 Adicionar Imports (TOP do arquivo)

**Encontre:**
```typescript
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  // ... outros tipos
} from "./types";
```

**Mude PARA:**
```typescript
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type CustomActionNodeConfig,  // ← ADD
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type SetVarNodeConfig,         // ← ADD
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";
```

**Além disso, adicione APÓS os imports de types:**

```typescript
import { createOrderDeal, type OrderDeliveryKind, type OrderPaymentMethod } from "@/lib/orders/create-order";
```

### 2.2 Integrar no Loop de Execução

**Encontre a função `advanceFromNodeKey` (por volta da linha 580).**

**Procure por este código:**
```typescript
if (node.node_type === "set_tag") {
  const cfg = node.config as unknown as SetTagNodeConfig;
  try {
    if (cfg.mode === "add") {
      // ... set_tag logic
    }
  } catch (err) {
    // ...
  }
  currentKey = cfg.next_node_key;
  continue;
}
```

**ADICIONE LOGO DEPOIS:**

```typescript
if (node.node_type === "set_var") {
  const cfg = node.config as unknown as SetVarNodeConfig;
  try {
    if (cfg.var_key) {
      const interpolated = interpolateVars(cfg.value, run.vars);
      const newVars = { ...run.vars, [cfg.var_key]: interpolated };
      const { error } = await db
        .from("flow_runs")
        .update({ vars: newVars })
        .eq("id", run.id);
      if (!error) {
        run.vars = newVars;
        await logEvent(db, run.id, "node_entered", node.node_key, {
          var_key: cfg.var_key,
          var_value: interpolated,
        });
      }
    }
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "set_var_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  currentKey = cfg.next_node_key;
  continue;
}

if (node.node_type === "custom_action") {
  const cfg = node.config as unknown as CustomActionNodeConfig;
  
  if (cfg.action === "create_order_deal") {
    try {
      const {
        nome,
        total,
        endereco,
        delivery_type,
        payment_method,
      } = run.vars as Record<string, unknown>;

      if (!nome || total === undefined || !delivery_type) {
        throw new Error("Missing required order vars: nome, total, delivery_type");
      }

      // ✅ CHAMADA DIRETA (sem HTTP)
      const result = await createOrderDeal(
        supabaseAdmin(),
        { accountId: run.account_id, userId: run.user_id },
        {
          contactId: run.contact_id!,
          customerName: String(nome),
          deliveryKind: String(delivery_type) as OrderDeliveryKind,
          paymentMethod: (payment_method || "pix") as OrderPaymentMethod,
          total: Number(total),
          deliveryAddress:
            delivery_type === "delivery" ? String(endereco) : undefined,
          paidOnline: payment_method === "mercado_pago",
          conversationId: run.conversation_id,
        }
      );

      await logEvent(db, run.id, "node_entered", node.node_key, {
        action_type: "create_order_deal",
        deal_id: result.dealId,
        tag: result.tagName,
      });
    } catch (err) {
      console.error("[flows] create_order_deal error:", err);
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "create_order_deal_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  
  currentKey = cfg.next_node_key;
  continue;
}
```

**Resultado esperado:** Agora o loop reconhece `set_var` e `custom_action` antes de chegar no `handoff`.

---

# PASSO 3: Atualizar validate.ts

## 📁 Arquivo: `src/lib/flows/validate.ts`

### 3.1 Adicionar Validação de set_var e custom_action

**Encontre a seção `validateNode()` (por volta da linha 674).**

**Procure por:**
```typescript
case "set_tag": {
  const cfg = node.config as { tag_id?: string; next_node_key?: string };
  if (!cfg.tag_id) {
    issues.push({
      // ...
    });
  }
  if (!cfg.next_node_key) {
    // ...
  }
  break;
}

case "handoff":
case "end":
  // Terminal nodes have no outgoing edges...
  break;

default:
  issues.push({
    severity: "error",
    scope: "node",
    node_key: node.node_key,
    message: `Unknown node type "${node.node_type}".`,
  });
```

**ADICIONE ANTES do `default` case:**

```typescript
case "set_var": {
  const cfg = node.config as { var_key?: string; value?: string; next_node_key?: string };
  if (!cfg.var_key) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "var_key",
      message: "Set-var needs a variable name.",
    });
  }
  if (cfg.value === undefined || cfg.value === "") {
    issues.push({
      severity: "warning",
      scope: "node",
      node_key: node.node_key,
      field: "value",
      message: "Set-var value is empty.",
    });
  }
  if (!cfg.next_node_key) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "next_node_key",
      message: "Set-var must point to a next node.",
    });
  } else if (!knownKeys.has(cfg.next_node_key)) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "next_node_key",
      message: `Set-var points to non-existent node "${cfg.next_node_key}".`,
    });
  }
  break;
}

case "custom_action": {
  const cfg = node.config as { action?: string; next_node_key?: string };
  if (!cfg.action) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "action",
      message: "Custom action needs an action type.",
    });
  }
  if (!cfg.next_node_key) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "next_node_key",
      message: "Custom action must point to a next node.",
    });
  } else if (!knownKeys.has(cfg.next_node_key)) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: node.node_key,
      field: "next_node_key",
      message: `Custom action points to non-existent node "${cfg.next_node_key}".`,
    });
  }
  break;
}
```

### 3.2 Atualizar outgoingEdges()

**Encontre a função `outgoingEdges()` (por volta da linha 750).**

**Procure por:**
```typescript
function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    // ...
```

**MUDE PARA:**
```typescript
function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "set_var":           // ← ADD
    case "custom_action": {   // ← ADD
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    // ... rest of function
```

---

# PASSO 4: Atualizar o Flow

## 📁 Arquivo: `src/lib/flows/pedido-empanadas-flow.ts`

### 4.1 Adicionar Imports

**Encontre:**
```typescript
import type {
  CollectInputNodeConfig,
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
} from './types';
```

**Mude PARA:**
```typescript
import type {
  CollectInputNodeConfig,
  CustomActionNodeConfig,  // ← ADD
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
} from './types';
```

### 4.2 Atualizar Nós de Confirmação

**Para CADA nó de confirmação:**
- `confirm_pix`
- `confirm_cartao_delivery`
- `confirm_pagamento_retirada`
- `confirm_mercado_pago`

**MUDE o `next_node_key`:**

Antes:
```typescript
{
  node_key: 'confirm_pix',
  node_type: 'send_message',
  config: {
    text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com\n...',
    next_node_key: 'handoff_pedido',  // ← OLD
  } as SendMessageNodeConfig,
},
```

Depois:
```typescript
{
  node_key: 'confirm_pix',
  node_type: 'send_message',
  config: {
    text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com\n...',
    next_node_key: 'criar_deal_automatico',  // ← NEW
  } as SendMessageNodeConfig,
},
```

### 4.3 Adicionar Nó Custom Action

**Encontre o nó `handoff_pedido`:**

```typescript
{
  node_key: 'handoff_pedido',
  node_type: 'handoff',
  config: {
    note: '🫔 Novo pedido (catálogo Meta)...',
  } as HandoffNodeConfig,
},
```

**ADICIONE ANTES dele:**

```typescript
// ========== CRIAR DEAL AUTOMATICAMENTE NO PIPELINE ==========
{
  node_key: 'criar_deal_automatico',
  node_type: 'custom_action',
  config: {
    action: 'create_order_deal',
    next_node_key: 'handoff_pedido',
  } as CustomActionNodeConfig,
},
```

### 4.4 Resultado Esperado

**Fluxo final:**
```
confirm_pix → criar_deal_automatico → handoff_pedido
confirm_cartao_delivery → criar_deal_automatico → handoff_pedido
confirm_pagamento_retirada → criar_deal_automatico → handoff_pedido
confirm_mercado_pago → criar_deal_automatico → handoff_pedido
```

---

# PASSO 5: Verificar Pré-requisitos

## ⚠️ Banco de Dados

O flow espera:
1. Pipeline com nome: `"Pedidos Delivery"`
2. Stage com nome: `"Novo Pedido"` dentro do pipeline

**Verificar:**
```sql
SELECT id, name FROM pipelines 
WHERE account_id = 'seu-account-id' 
AND name = 'Pedidos Delivery';

SELECT id, name FROM pipeline_stages 
WHERE pipeline_id = 'id-do-pipeline-acima' 
AND name = 'Novo Pedido';
```

**Se não existirem, criar via Dashboard ou SQL:**
```sql
-- Criar pipeline
INSERT INTO pipelines (account_id, user_id, name)
VALUES ('seu-account-id', 'seu-user-id', 'Pedidos Delivery')
RETURNING id;

-- Usar o ID retornado abaixo:
INSERT INTO pipeline_stages (pipeline_id, name, position)
VALUES ('id-do-pipeline', 'Novo Pedido', 0);
```

---

# PASSO 6: Testar

## 6.1 Build Check

```bash
npm run build
```

**Deve compilar sem erros.** Se houver erro, procure por:
- ❌ Type mismatch em `CustomActionNodeConfig` ou `SetVarNodeConfig`
- ❌ Import missing de `createOrderDeal`
- ❌ `supabaseAdmin()` não importado em engine.ts

## 6.2 Dev Server

```bash
npm run dev
```

**Procure nos logs por:**
```
[flows] Order deal created: deal-uuid-xxx
```

## 6.3 Teste Completo Manual

1. **Abra WhatsApp integrado**
2. **Envie pedido via catálogo Meta** (ou teste manual do flow)
3. **Complete o flow:**
   - Nome: "Teste Silva"
   - Tipo: Delivery ou Retirada
   - Endereço: "Rua Teste, 123" (se delivery)
   - Pagamento: Pix
4. **Verificar no Dashboard:**
   - Sidebar → "Pedidos"
   - Pipeline: "Pedidos Delivery"
   - Estágio: "Novo Pedido"
   - ✅ **Deve aparecer:** "Pedido - Teste Silva" (R$ XX,XX)
5. **Verificar Tags:**
   - Clique no deal
   - Contact deve ter tag: "Aguardando Pagamento" (ou "Confirmado" se mercado_pago)

---

# 🐛 Troubleshooting

| Erro | Causa | Solução |
|------|-------|---------|
| **Build: "Unknown node type"** | validate.ts não reconhece set_var/custom_action | Verificar seção 3.2 - outgoingEdges() |
| **Runtime: "Missing required order vars"** | Variáveis do flow vazias | Verificar se nome/total/delivery_type foram capturados |
| **Deal não aparece** | createOrderDeal lançou erro silenciosamente | Verificar logs: `[flows] create_order_deal error:` |
| **Pipeline "Pedidos Delivery" não encontrado** | Pipeline não existe | Criar via Dashboard ou SQL |
| **"contactId required" na API** | run.contact_id é null | Verificar integração WhatsApp |

### Debug: Ver Vars do Flow

```typescript
// Adicionar temporariamente em engine.ts antes do create_order_deal:
console.log('[DEBUG] Flow vars:', JSON.stringify(run.vars, null, 2));
console.log('[DEBUG] contact_id:', run.contact_id);
console.log('[DEBUG] account_id:', run.account_id);
```

---

# ✅ Checklist Final

### Tipos TypeScript
- [ ] Adicionei `CustomActionNodeConfig` em `types.ts`
- [ ] Adicionei `SetVarNodeConfig` com `value: string` em `types.ts`

### Engine
- [ ] Importei `CustomActionNodeConfig`, `SetVarNodeConfig` em `engine.ts`
- [ ] Importei `createOrderDeal`, `OrderDeliveryKind`, `OrderPaymentMethod` em `engine.ts`
- [ ] Adicionei `set_var` case no loop `advanceFromNodeKey()`
- [ ] Adicionei `custom_action` case no loop `advanceFromNodeKey()`
- [ ] `custom_action` chama `createOrderDeal()` **direto** (sem HTTP)

### validate.ts
- [ ] Adicionei `set_var` case em `validateNode()`
- [ ] Adicionei `custom_action` case em `validateNode()`
- [ ] Atualizei `outgoingEdges()` para incluir `set_var` e `custom_action`

### Flow
- [ ] Importei `CustomActionNodeConfig` em `pedido-empanadas-flow.ts`
- [ ] Adicionei nó `criar_deal_automatico` com `node_type: 'custom_action'`
- [ ] Mudei todos os `confirm_*` → `next_node_key: 'criar_deal_automatico'`

### Banco
- [ ] Pipeline "Pedidos Delivery" existe
- [ ] Stage "Novo Pedido" existe
- [ ] Migration 032 foi executada (node_type CHECK tem set_var + custom_action)

### Testes
- [ ] `npm run build` passa sem erros
- [ ] Dev server inicia sem erros
- [ ] Enviei pedido via WhatsApp
- [ ] Deal aparece no pipeline
- [ ] Tags aplicadas corretamente
- [ ] Logs mostram: `[flows] Order deal created: ...`

---

# 📊 Fluxo Visual Final

```
┌─────────────────────────────────────────┐
│ Cliente envia pedido (catálogo Meta)   │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ Flow coleta dados:                      │
│ ├─ nome (collect_input)                 │
│ ├─ delivery_type (send_buttons)         │
│ ├─ endereco (collect_input, se delivery)│
│ └─ payment_method (send_buttons/list)   │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ Confirmação de pagamento                │
│ (send_message)                          │
│ next_node_key: criar_deal_automatico    │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ [NOVO] custom_action                    │
│ ├─ Valida dados (nome, total, tipo)     │
│ ├─ Chama createOrderDeal() direto       │
│ ├─ Deal criado no pipeline              │
│ └─ Tags aplicadas ao contato            │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ Handoff ao atendente                    │
│ (resume da conversa)                    │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ ✅ Deal visível no Pipeline             │
│ "Pedido - João Silva" (R$ 42,00)        │
│ Tag: "Confirmado" ou                    │
│       "Aguardando Pagamento"            │
└─────────────────────────────────────────┘
```

---

# 🎁 Próximos Passos (Opcional)

1. **Mercado Pago Automático:** Webhook do MP → confirm pagamento → tag "Confirmado"
2. **SMS/WhatsApp de Confirmação:** Enviar mensagem automática quando deal for criado
3. **Atualizar Status:** Botões no dashboard para mover deal entre estágios
4. **Relatórios:** Dashboard com total de pedidos, receita, etc.

---

## ✨ Você está pronto para implementar!

**Comece pelo PASSO 0 (Migration) e siga a ordem. Cada passo é independente mas sequencial.**

**Qualquer dúvida, check o Troubleshooting ou os logs do dev server. 🚀**
