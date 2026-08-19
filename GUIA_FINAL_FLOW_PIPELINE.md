# 🚀 GUIA PRÁTICO: Implementar Flow → Pipeline Automático

## ✅ Status Atual
- ✅ Banco de dados: Migration já pronta com `set_var` e `custom_action`
- ✅ Endpoint `/api/orders`: Já existe e funciona
- ❌ Engine do Flow: Precisa suportar `custom_action`
- ❌ Tipos TypeScript: Precisa de `CustomActionNodeConfig`
- ❌ Flow: Precisa de nó `custom_action` integrado

---

## 🎯 Objetivo
**Quando flow terminar → Deal aparece automaticamente no Pipeline**

---

# PASSO 1: Adicionar Tipos TypeScript

## 📁 Arquivo: `src/lib/flows/types.ts`

### Encontre:
```typescript
export interface SendMessageNodeConfig {
  text: string;
  next_node_key: string;
  header_text?: string;
  footer_text?: string;
}
```

### Adicione ANTES de `HandoffNodeConfig`:

```typescript
export interface CustomActionNodeConfig {
  /**
   * The action to execute. Supported:
   *   - 'create_order_deal': Creates an order deal in the pipeline
   */
  action: 'create_order_deal';
  /** Next node after action completes */
  next_node_key: string;
}
```

### Adicione também (se não existir):
```typescript
export interface SetVarNodeConfig {
  /**
   * Persist a value into flow_runs.vars
   */
  var_key: string;
  var_value: unknown;
  next_node_key: string;
}
```

---

# PASSO 2: Atualizar Flow Engine

## 📁 Arquivo: `src/lib/flows/engine.ts`

### 2.1 Adicionar Imports
**Encontre:**
```typescript
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  // ... outros tipos
  type KeywordTriggerConfig,
} from "./types";
```

**Adicione:**
```typescript
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type CustomActionNodeConfig,  // ← ADD
  type SetVarNodeConfig,         // ← ADD
  // ... outros tipos
  type KeywordTriggerConfig,
} from "./types";
```

### 2.2 Adicionar Função de Custom Action

**Encontre a função `executeHandoff` (por volta da linha 466):**

**Adicione DEPOIS dela:**

```typescript
/**
 * Execute custom actions (create order, generate payment links, etc).
 * Non-fatal — log errors but don't fail the run.
 */
async function executeCustomAction(
  db: AdminClient,
  run: FlowRunRow,
): Promise<void> {
  try {
    const cfg = run.current_node_key 
      ? (/* get config from node */ {} as unknown as CustomActionNodeConfig)
      : null;
    
    if (!cfg || cfg.action !== 'create_order_deal') return;

    const {
      nome,
      total,
      endereco,
      delivery_type,
      payment_method,
    } = run.vars as Record<string, unknown>;

    if (!nome || total === undefined || !delivery_type) {
      console.warn('[flows] Missing required order vars');
      return;
    }

    // Call POST /api/orders to create deal
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: run.contact_id,
          customerName: String(nome),
          deliveryKind: String(delivery_type),
          paymentMethod: payment_method || 'pix',
          total: Number(total),
          deliveryAddress: 
            delivery_type === 'delivery' ? String(endereco) : undefined,
          paidOnline: payment_method === 'mercado_pago',
          conversationId: run.conversation_id,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Order API ${response.status}: ${errorText}`
      );
    }

    const result = await response.json();
    console.log('[flows] Order deal created:', result.dealId);

    await logEvent(db, run.id, 'node_entered', run.current_node_key, {
      action_type: 'create_order_deal',
      deal_id: result.dealId,
      tag: result.tagName,
    });
  } catch (err) {
    console.error('[flows] executeCustomAction error:', err);
    await logEvent(db, run.id, 'error', run.current_node_key, {
      reason: 'custom_action_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Set a variable in flow_runs.vars (persist user choices, etc).
 */
async function executeSetVar(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SetVarNodeConfig;
  
  if (cfg.var_key) {
    const newVars = { ...run.vars, [cfg.var_key]: cfg.var_value };
    const { error } = await db
      .from('flow_runs')
      .update({ vars: newVars })
      .eq('id', run.id);
    
    if (!error) {
      run.vars = newVars;
      await logEvent(db, run.id, 'node_entered', node.node_key, {
        var_key: cfg.var_key,
        var_value: cfg.var_value,
      });
    }
  }
  
  return { outcome: 'advanced', node_key: node.node_key };
}
```

### 2.3 Integrar no Loop de Execução

**Encontre a função `advanceFromNodeKey` (por volta da linha 580):**

**Procure por:**
```typescript
if (node.node_type === "set_tag") {
  const cfg = node.config as unknown as SetTagNodeConfig;
  try {
    // ... set_tag logic
  }
  currentKey = cfg.next_node_key;
  continue;
}
```

**ADICIONE DEPOIS:**

```typescript
if (node.node_type === "set_var") {
  const result = await executeSetVar(db, run, node);
  const advanced = await advanceCurrentNodeKey(
    db,
    run.id,
    run.current_node_key,
    result.node_key,
  );
  if (!advanced) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "lost_race_during_advance",
    });
  }
  const cfg = node.config as unknown as SetVarNodeConfig;
  currentKey = cfg.next_node_key;
  continue;
}

if (node.node_type === "custom_action") {
  await executeCustomAction(db, run);
  const cfg = node.config as unknown as CustomActionNodeConfig;
  currentKey = cfg.next_node_key;
  continue;
}
```

---

# PASSO 3: Atualizar o Flow

## 📁 Arquivo: `src/lib/flows/pedido-empanadas-flow.ts`

### 3.1 Adicionar Imports

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

**Mude para:**
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

### 3.2 Adicionar Nó Custom Action

**Encontre o nó `handoff_pedido`:**

```typescript
{
  node_key: 'handoff_pedido',
  node_type: 'handoff',
  config: {
    note: '🫔 Novo pedido...',
  } as HandoffNodeConfig,
},
```

**ADICIONE ANTES dele:**

```typescript
// ========== CRIAR DEAL AUTOMATICAMENTE ==========
{
  node_key: 'criar_deal_automatico',
  node_type: 'custom_action',
  config: {
    action: 'create_order_deal',
    next_node_key: 'handoff_pedido',
  } as CustomActionNodeConfig,
},
```

### 3.3 Atualizar Confirmações

**Para CADA nó de confirmação:**
- `confirm_pix`
- `confirm_cartao_delivery`
- `confirm_pagamento_retirada`
- `confirm_mercado_pago`

**MUDE:**
```typescript
next_node_key: 'handoff_pedido',  // ← OLD
```

**PARA:**
```typescript
next_node_key: 'criar_deal_automatico',  // ← NEW
```

### 3.4 Exemplo Completo

**Antes:**
```typescript
{
  node_key: 'confirm_pix',
  node_type: 'send_message',
  config: {
    text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com\n...',
    next_node_key: 'handoff_pedido',  // ← Direto pro handoff
  } as SendMessageNodeConfig,
},
{
  node_key: 'handoff_pedido',
  node_type: 'handoff',
  config: {
    note: '🫔 Novo pedido...',
  } as HandoffNodeConfig,
},
```

**Depois:**
```typescript
{
  node_key: 'confirm_pix',
  node_type: 'send_message',
  config: {
    text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com\n...',
    next_node_key: 'criar_deal_automatico',  // ← Para custom_action
  } as SendMessageNodeConfig,
},

// ← NOVO NÓ
{
  node_key: 'criar_deal_automatico',
  node_type: 'custom_action',
  config: {
    action: 'create_order_deal',
    next_node_key: 'handoff_pedido',  // ← Depois vai para handoff
  } as CustomActionNodeConfig,
},

{
  node_key: 'handoff_pedido',
  node_type: 'handoff',
  config: {
    note: '🫔 Novo pedido...',
  } as HandoffNodeConfig,
},
```

---

# PASSO 4: Verificar Pipeline Existe

## ⚠️ Pré-requisitos no Banco

**O flow espera:**
1. Pipeline com nome: `"Pedidos Delivery"`
2. Stage com nome: `"Novo Pedido"` (dentro do pipeline)

**Criar via Dashboard:**

1. Sidebar → Pedidos
2. Clique "+" para novo pipeline
3. Nome: `Pedidos Delivery`
4. Adicione stage: `Novo Pedido`

**OU via SQL:**
```sql
-- Criar pipeline
INSERT INTO pipelines (account_id, user_id, name)
VALUES ('seu-account-id', 'seu-user-id', 'Pedidos Delivery')
RETURNING id;

-- Copie o id acima e use abaixo:
INSERT INTO pipeline_stages (pipeline_id, name)
VALUES ('id-do-pipeline', 'Novo Pedido');
```

---

# PASSO 5: Testar

## 5.1 Variáveis de Ambiente

```bash
# .env.local
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## 5.2 Iniciar Dev Server

```bash
npm run dev
```

## 5.3 Teste Completo

**Simular pedido:**

1. Abra WhatsApp integrado
2. **Envie um pedido** via catálogo Meta (ou teste manual)
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

## 5.4 Verificar Logs

```bash
# Terminal do npm run dev:
[flows] Order deal created: deal-abc123def456
```

---

# 🐛 Troubleshooting

| Erro | Causa | Solução |
|------|-------|---------|
| **"Pipeline 'Pedidos Delivery' não encontrado"** | Pipeline não existe | Criar pipeline via Dashboard |
| **"Stage 'Novo Pedido' não encontrado"** | Stage não existe | Criar stage no pipeline |
| **Deal não aparece** | Custom action falhou silenciosamente | Verificar logs: `[flows]` |
| **"contactId required"** | `run.contact_id` é null | Verificar integração WhatsApp |
| **API 400 bad request** | Dados do flow incompletos | Verificar `vars` no log |

### Debug: Ver Vars do Flow

```typescript
// Adicionar no console do executeCustomAction:
console.log('[DEBUG] Flow vars:', JSON.stringify(run.vars, null, 2));
```

---

# ✅ Checklist de Implementação

### Tipos TypeScript
- [ ] Adicionei `CustomActionNodeConfig` em `types.ts`
- [ ] Adicionei `SetVarNodeConfig` em `types.ts`

### Engine
- [ ] Importei novos tipos em `engine.ts`
- [ ] Adicionei `executeCustomAction()` em `engine.ts`
- [ ] Adicionei `executeSetVar()` em `engine.ts`
- [ ] Integrei no `advanceFromNodeKey()` loop

### Flow
- [ ] Importei `CustomActionNodeConfig` em `pedido-empanadas-flow.ts`
- [ ] Adicionei nó `criar_deal_automatico`
- [ ] Mudei todos os confirm_* → `next_node_key: 'criar_deal_automatico'`

### Banco
- [ ] Pipeline "Pedidos Delivery" existe
- [ ] Stage "Novo Pedido" existe

### Testes
- [ ] Dev server rodando
- [ ] Enviei pedido via WhatsApp
- [ ] Deal aparece no pipeline
- [ ] Tags aplicadas corretamente
- [ ] Logs mostram sucesso

---

# 📊 Fluxo Final

```
Cliente envia pedido (catálogo Meta)
    ↓
Flow coleta dados (nome, tipo, endereço, pagamento)
    ↓
Confirmação de pagamento
    ↓
[NOVO] Nó custom_action executa:
    • POST /api/orders com dados do flow
    • Deal criado automaticamente
    • Tags aplicadas ao contato
    ↓
Handoff ao atendente
    ↓
✅ Deal visível no Pipeline "Pedidos Delivery"
```

---

## 🎁 Próximos Passos (Opcional)

1. **Integrar Mercado Pago:** Webhook para confirmar pagamento → tag "Confirmado"
2. **Enviar confirmação:** SMS/WhatsApp automático após deal criado
3. **Atualizar status:** Botões no dashboard para mover deal entre estágios
4. **Relatórios:** Dashboard com total de pedidos, receita, etc.

---

**Você está pronto para implementar! 🚀 Comece pelo PASSO 1 e siga a ordem.**
