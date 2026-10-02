# Kanban UI - Deal Stage Movement Buttons

## Overview

Implementação de menu de ações (⋯) nos cards de pedidos do Kanban, permitindo agentes moverem deals entre stages com um clique.

---

## Components Criados

### 1. `src/hooks/use-deal-stage-movement.ts`
**Hook customizado** para gerenciar o movimento de deals.

```typescript
const { moveDealToStage, isLoading, error } = useDealStageMovement()

await moveDealToStage('deal-id', 'Na Cozinha')
// → POST /api/deals/[id]/move-stage
// → Toast de sucesso/erro
// → Re-fetch automático (callback)
```

**Características:**
- ✅ Integração com API `/api/deals/[id]/move-stage`
- ✅ Toast de feedback via `sonner`
- ✅ Loading state durante requisição
- ✅ Error handling com mensagens customizadas

### 2. `src/components/pipelines/deal-card-actions.tsx`
**Componente dropdown** com menu de ações para mover deals.

```tsx
<DealCardActions
  deal={deal}
  currentStage={stage}
  allStages={allStages}
  onDealUpdated={onRefresh}
/>
```

**Features:**
- 🎯 Exibe apenas os próximos stages (fluxo para frente)
- 🔄 Loading spinner durante movimento
- 🎨 Ícone ChevronRight para indicar "próximo"
- 🚫 Desativado se não há próximos stages (ex: "Entregue")
- 📱 Menu otimizado para mobile/desktop

---

## Components Modificados

### `src/components/pipelines/deal-card.tsx`
- ✅ Adicionado `allStages?: PipelineStage[]`
- ✅ Adicionado `onDealUpdated?: () => void`
- ✅ Menu de ações renderizado ao lado do title
- ✅ Oculto em overlay (drag preview)

### `src/components/pipelines/pipeline-board.tsx`
- ✅ Adicionado `onDealsRefresh?: () => void` prop
- ✅ `allStages` propagado para `StageColumn`
- ✅ `onDealUpdated` callback ao mover deals
- ✅ `DraggableDealCard` atualizado com novos props

---

## Fluxo de Uso

```
1. Agent abre card no Kanban
2. Clica no ícone ⋯ (more options)
3. Menu aparece com próximos stages:
   "Novo Pedido" → [Na Cozinha] [Pronto...] [Entregue]
4. Clica em "Na Cozinha"
5. 🔄 Loading spinner
6. ✅ Toast: "Card movido com sucesso"
7. Card atualiza para novo stage (via re-fetch)
```

---

## Visual

```
┌─────────────────────────────────┐
│ Pedido - João Silva        [⋯]  │  ← Menu trigger
├─────────────────────────────────┤
│ 📱 João Silva               👤   │
│                                  │
│ R$ 140,00    12 Nov 2024        │
└─────────────────────────────────┘

[Clicou em ⋯]
┌─────────────────────────────────┐
│ Mover para                       │
│ ─────────────────────────────── │
│ ▶ Na Cozinha                    │
│ ▶ Pronto para Entrega           │
│ ▶ Entregue                      │
└─────────────────────────────────┘
```

---

## Props Flow

```
PipelineBoard
  ├── stages: PipelineStage[]
  ├── onDealsRefresh?: () => void
  │
  └── StageColumn
      ├── stage: PipelineStage
      ├── allStages: PipelineStage[]
      ├── onDealUpdated?: () => void
      │
      └── DraggableDealCard
          ├── deal: Deal
          ├── allStages: PipelineStage[]
          ├── onDealUpdated?: () => void
          │
          └── DealCard
              ├── stage: PipelineStage | null
              ├── allStages: PipelineStage[]
              ├── onDealUpdated?: () => void
              │
              └── DealCardActions
                  ├── deal: Deal
                  ├── currentStage: PipelineStage
                  ├── allStages: PipelineStage[]
                  └── onDealUpdated?: () => void
```

---

## API Integration

```typescript
// Quando agent clica em "Na Cozinha":
POST /api/deals/[id]/move-stage
{
  "stage": "Na Cozinha"
}

// Response:
{
  "ok": true,
  "moved": true,
  "stage": "Na Cozinha"
}

// Internamente:
// 1. Deal move para stage "Na Cozinha"
// 2. Order status = 'payment_approved'
// 3. Toast de sucesso
// 4. Callback onDealUpdated() → re-fetch deals
```

---

## Error Handling

```typescript
// Erro de validação
POST /api/deals/[id]/move-stage {"stage": "Invalid Stage"}
→ Status 400
→ Toast: "Invalid stage. Valid stages: Novo Pedido, Na Cozinha, ..."

// Erro de BD/servidor
→ Status 500
→ Toast: "Erro ao mover card: Database error"

// Network error
→ Toast: "Erro ao mover card: Network timeout"
```

---

## Next Phase (Future)

- [ ] Keyboard shortcuts (ex: `Cmd+K` → stage picker)
- [ ] Batch movement (mover múltiplos cards)
- [ ] Undo/Redo (últimas 5 movimentos)
- [ ] Stage transition animations
- [ ] Mobile hamburger menu para stages

---

## Testing

```bash
npm run typecheck  # ✅ PASS
npm run test       # ✅ 672/672 PASS
```

No changes to existing tests — all passing ✅

---

## Usage Example

```tsx
import { PipelineBoard } from '@/components/pipelines/pipeline-board'

export function PipelineView() {
  const [deals, setDeals] = useState<Deal[]>([])
  const stages = usePipelineStages()

  const handleDealsRefresh = () => {
    // Re-fetch deals quando um foi movido
    refetchDeals()
  }

  return (
    <PipelineBoard
      stages={stages}
      deals={deals}
      onDealsRefresh={handleDealsRefresh}
      onDealMoved={handleDragMoved}
      onEditDeal={handleEdit}
      onAddDeal={handleAdd}
    />
  )
}
```

---

## Migration Notes

✅ **Backward Compatible:**
- `allStages` é optional
- `onDealUpdated` é optional
- Se não fornecidos, menu de ações não aparece

✅ **No Breaking Changes:**
- DealCard continua funcionando sem novos props
- PipelineBoard mantém assinatura anterior

---

## Commit Info

```
feat: add Kanban UI buttons for deal stage movement

- Create useDealStageMovement hook for API integration
- Add DealCardActions dropdown menu to each card
- Show next available stages in menu (forward-only flow)
- Toast notifications for success/error feedback
- Loading spinner during movement
- Props flow: allStages propagated through component tree
- Backward compatible: all new props are optional
```
