/**
 * auto-deal-lifecycle.ts
 *
 * Automação completa do ciclo de vida de deals para pedidos delivery:
 * - Cria deals automaticamente ao receber inbound WhatsApp
 * - Atualiza deals quando pagamento é aprovado
 * - Garante idempotência (uma conversa = um deal aberto)
 * - Move deals entre stages conforme transições de pagamento
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildOrderTitle } from '@/lib/orders/create-order'
import { resolvePipeline, resolveStage, PIPELINE_STAGES } from '@/lib/orders/pipeline-stages'

/**
 * Busca um deal aberto para o cliente nas últimas 6 horas.
 * Retorna o deal se existir, null caso contrário.
 */
export async function findActiveConversationDeal(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<{ id: string; value: number; stage_id: string } | null> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

  const { data, error } = await db
    .from('deals')
    .select('id, value, stage_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('conversation_id', conversationId)
    .eq('status', 'open')
    .gte('created_at', sixHoursAgo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[auto-deal] findActiveConversationDeal error:', error)
    return null
  }

  return data ?? null
}

/**
 * Busca um deal aberto para o cliente (qualquer conversa, últimas 6 horas).
 * Útil para garantir que não criamos múltiplos deals em paralelo.
 */
export async function findRecentOpenDeal(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ id: string; conversation_id: string; value: number } | null> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

  const { data, error } = await db
    .from('deals')
    .select('id, conversation_id, value')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .gte('created_at', sixHoursAgo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[auto-deal] findRecentOpenDeal error:', error)
    return null
  }

  return data ?? null
}

export interface AutoDealInput {
  accountId: string
  userId: string
  contactId: string
  contactName: string
  conversationId: string
}

export interface AutoDealResult {
  dealId: string
  isNew: boolean
  pipelineId: string
  stageId: string
}

/**
 * Cria ou retorna deal aberto para a conversa.
 * Se já existe deal aberto na mesma conversa (últimas 6h), retorna esse.
 * Caso contrário, cria novo deal no estágio "Novo Pedido".
 *
 * Garante idempotência: múltiplas mensagens na mesma conversa
 * ficam todas atreladas ao mesmo deal.
 */
export async function ensureAutoDealForConversation(
  db: SupabaseClient,
  input: AutoDealInput,
): Promise<AutoDealResult> {
  const { accountId, userId, contactId, contactName, conversationId } = input

  // 1. Busca deal já aberto nesta conversa
  const existingDeal = await findActiveConversationDeal(
    db,
    accountId,
    contactId,
    conversationId,
  )

  if (existingDeal) {
    console.log('[auto-deal] reusing existing deal for conversation:', {
      dealId: existingDeal.id,
      conversationId,
    })
    return {
      dealId: existingDeal.id,
      isNew: false,
      pipelineId: '', // preenchido abaixo se necessário
      stageId: existingDeal.stage_id,
    }
  }

  // 2. Resolve pipeline "Pedidos Delivery"
  const pipelineResult = await resolvePipeline(db, accountId, userId)
  const pipelineId = pipelineResult.id

  // 3. Resolve estágio "Novo Pedido"
  const stageResult = await resolveStage(
    db,
    pipelineId,
    PIPELINE_STAGES.NEW_ORDER,
  )
  if (!stageResult) {
    throw new Error('Could not resolve "Novo Pedido" stage')
  }
  const stageId = stageResult.id

  // 4. Cria novo deal
  const title = buildOrderTitle(contactName)
  const { data: newDeal, error: createErr } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: userId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: contactId,
      conversation_id: conversationId,
      title,
      value: 0,
      currency: 'BRL',
      status: 'open',
      notes: 'Deal criado automaticamente ao receber mensagem',
    })
    .select('id')
    .single()

  if (createErr) {
    console.error('[auto-deal] create deal error:', createErr)
    throw createErr
  }

  const dealId = newDeal.id
  console.log('[auto-deal] created new deal for conversation:', {
    dealId,
    conversationId,
    contactId,
  })

  return {
    dealId,
    isNew: true,
    pipelineId,
    stageId,
  }
}

/**
 * Atualiza deal com valor de pagamento aprovado.
 * Move deal para "Na Cozinha" (payment_approved) quando pagamento é confirmado.
 */
export async function updateDealWithPayment(
  db: SupabaseClient,
  args: {
    accountId: string
    dealId: string
    paidAmount: number
  },
): Promise<void> {
  const { accountId, dealId, paidAmount } = args

  // 1. Busca o deal e sua pipeline
  const { data: deal, error: dealErr } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (dealErr || !deal) {
    console.warn('[auto-deal] deal not found for payment update:', dealId)
    return
  }

  // 2. Resolve estágio "Na Cozinha"
  const stageResult = await resolveStage(
    db,
    deal.pipeline_id,
    PIPELINE_STAGES.COOKING,
  )
  if (!stageResult) {
    console.warn('[auto-deal] could not resolve "Na Cozinha" stage')
    return
  }

  // 3. Atualiza deal: valor + move para "Na Cozinha"
  const { error: updateErr } = await db
    .from('deals')
    .update({
      value: paidAmount,
      stage_id: stageResult.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', dealId)

  if (updateErr) {
    console.error('[auto-deal] failed to update deal with payment:', updateErr)
    return
  }

  console.log('[auto-deal] updated deal with payment:', {
    dealId,
    paidAmount,
    newStage: PIPELINE_STAGES.COOKING,
  })
}

/**
 * Marca deal como finalizado (status='won') quando entrega é concluída.
 * Útil para "Entregue" no Kanban.
 */
export async function closeDealAsDelivered(
  db: SupabaseClient,
  args: {
    accountId: string
    dealId: string
  },
): Promise<void> {
  const { accountId, dealId } = args

  const { data: deal, error: dealErr } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (dealErr || !deal) {
    console.warn('[auto-deal] deal not found for closure:', dealId)
    return
  }

  const stageResult = await resolveStage(
    db,
    deal.pipeline_id,
    PIPELINE_STAGES.DELIVERED,
  )
  if (!stageResult) {
    console.warn('[auto-deal] could not resolve "Entregue" stage')
    return
  }

  const { error: updateErr } = await db
    .from('deals')
    .update({
      stage_id: stageResult.id,
      status: 'won',
      updated_at: new Date().toISOString(),
    })
    .eq('id', dealId)

  if (updateErr) {
    console.error('[auto-deal] failed to close deal:', updateErr)
    return
  }

  console.log('[auto-deal] closed deal as delivered:', dealId)
}
