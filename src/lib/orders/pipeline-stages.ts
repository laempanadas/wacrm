/**
 * pipeline-stages.ts
 *
 * Gerencia os estágios expandidos do pipeline "Pedidos Delivery" (MVP).
 * Providencia helpers para mover deals entre estágios e sincronizar order.status.
 *
 * Stages:
 *   "Novo Pedido"         → Pedido criado, aguardando confirmação de pagamento
 *   "Na Cozinha"          → Pagamento aprovado, preparando pedido
 *   "Pronto para Entrega" → Pedido pronto, aguardando saída
 *   "Entregue"            → Pedido entregue ao cliente (final)
 *   "Pago"                → Status de fechamento (legacy, manter compatibilidade)
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const ORDERS_PIPELINE_NAME = 'Pedidos Delivery'

export const PIPELINE_STAGES = {
  NEW_ORDER: 'Novo Pedido',
  COOKING: 'Na Cozinha',
  READY: 'Pronto para Entrega',
  DELIVERED: 'Entregue',
  PAID: 'Pago', // Legacy — mantém compat com código existente
} as const

export type PipelineStageKey = keyof typeof PIPELINE_STAGES
export type PipelineStage = (typeof PIPELINE_STAGES)[PipelineStageKey]

/** Cores para cada stage (Verde → Azul → Roxo → Verde Escuro) */
const STAGE_COLORS: Record<PipelineStage, string> = {
  [PIPELINE_STAGES.NEW_ORDER]: '#fbbf24', // Amarelo
  [PIPELINE_STAGES.COOKING]: '#3b82f6', // Azul
  [PIPELINE_STAGES.READY]: '#8b5cf6', // Roxo
  [PIPELINE_STAGES.DELIVERED]: '#10b981', // Verde escuro
  [PIPELINE_STAGES.PAID]: '#16a34a', // Verde (legacy)
}

/** Mapeamento de stage → order.status */
export const STAGE_TO_ORDER_STATUS: Record<PipelineStage, string> = {
  [PIPELINE_STAGES.NEW_ORDER]: 'pending',
  [PIPELINE_STAGES.COOKING]: 'payment_approved',
  [PIPELINE_STAGES.READY]: 'ready',
  [PIPELINE_STAGES.DELIVERED]: 'delivered',
  [PIPELINE_STAGES.PAID]: 'paid',
}

/**
 * Resolve a pipeline ID pelo nome, criando-a se necessário.
 * Idempotente: se já existe, retorna o ID existente.
 */
export async function resolvePipeline(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: findErr } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', ORDERS_PIPELINE_NAME)
    .maybeSingle()

  if (findErr) throw findErr
  if (existing) return { id: existing.id, created: false }

  const { data: created, error: createErr } = await db
    .from('pipelines')
    .insert({
      account_id: accountId,
      user_id: userId,
      name: ORDERS_PIPELINE_NAME,
    })
    .select('id')
    .single()

  if (createErr) throw createErr
  return { id: created.id, created: true }
}

/**
 * Resolve um stage pelo nome, criando-o se necessário (no final da pipeline).
 * Retorna null se o stage name não for reconhecido.
 */
export async function resolveStage(
  db: SupabaseClient,
  pipelineId: string,
  stageName: PipelineStage,
): Promise<{ id: string; created: boolean } | null> {
  const color = STAGE_COLORS[stageName]
  if (!color) return null // stage desconhecido

  const { data: existing, error: findErr } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .eq('name', stageName)
    .maybeSingle()

  if (findErr) throw findErr
  if (existing) return { id: existing.id, created: false }

  // Stage não existe — criar ao final da pipeline
  const { data: allStages, error: allErr } = await db
    .from('pipeline_stages')
    .select('position')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: false })
    .limit(1)

  if (allErr) throw allErr

  const lastPosition = allStages?.[0]?.position ?? -1
  const nextPosition = lastPosition + 1

  const { data: created, error: createErr } = await db
    .from('pipeline_stages')
    .insert({
      pipeline_id: pipelineId,
      name: stageName,
      position: nextPosition,
      color,
    })
    .select('id')
    .single()

  if (createErr) throw createErr
  return { id: created.id, created: true }
}

/**
 * Move um deal para um novo stage e sincroniza order.status.
 * Best-effort: erros ao atualizar order não interrompem o movimento do deal.
 */
export async function moveDealToStage(
  db: SupabaseClient,
  args: {
    accountId: string
    dealId: string
    targetStage: PipelineStage
  },
): Promise<{ moved: boolean; reason?: string }> {
  const { accountId, dealId, targetStage } = args

  // 1. Buscar deal + pipeline
  const { data: deal, error: dealErr } = await db
    .from('deals')
    .select('id, pipeline_id, contact_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (dealErr || !deal) return { moved: false, reason: 'deal_not_found' }

  // 2. Resolver stage de destino
  const stageResult = await resolveStage(db, deal.pipeline_id, targetStage)
  if (!stageResult) return { moved: false, reason: 'invalid_stage' }

  // 3. Mover deal
  const { error: moveErr } = await db
    .from('deals')
    .update({
      stage_id: stageResult.id,
      status: targetStage === PIPELINE_STAGES.DELIVERED ? 'won' : 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', dealId)

  if (moveErr) return { moved: false, reason: 'move_failed' }

  // 4. Sincronizar order.status (best-effort)
  const newOrderStatus = STAGE_TO_ORDER_STATUS[targetStage]
  try {
    await db
      .from('orders')
      .update({ status: newOrderStatus })
      .eq('deal_id', dealId)
      .eq('account_id', accountId)
  } catch (err) {
    console.warn('[moveDealToStage] order sync failed:', err)
  }

  return { moved: true }
}

/**
 * Obter o nome do stage atual de um deal.
 */
export async function getDealCurrentStage(
  db: SupabaseClient,
  dealId: string,
): Promise<PipelineStage | null> {
  const { data } = await db
    .from('deals')
    .select('stage:pipeline_stages(name)')
    .eq('id', dealId)
    .maybeSingle()

  if (!data) return null

  const stageData = data.stage as unknown
  if (!stageData || typeof stageData !== 'object' || !('name' in stageData)) {
    return null
  }

  const stageName = (stageData as { name?: unknown }).name
  if (typeof stageName !== 'string') return null

  return Object.values(PIPELINE_STAGES).includes(stageName as PipelineStage)
    ? (stageName as PipelineStage)
    : null
}
