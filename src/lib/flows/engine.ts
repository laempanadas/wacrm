/**
 * Flow runner — La Empanadas.
 *
 * Processa o grafo de nós conversacionais, interpola variáveis em todos
 * os tipos de mensagem (texto, botões, listas) e integra a geração
 * automática de link do Mercado Pago na ação customizada `create_order_deal`.
 */

import { supabaseAdmin } from './admin-client';
import {
  authorizeFlowCheckout,
  confirmFlowCheckout,
  correctFlowCheckout,
  finishFlowCheckout,
  transitionFlowRun,
  writeFlowVars,
} from './checkout-consent';
import {
  createOrderDeal,
  type OrderDeliveryKind,
  type OrderPaymentMethod,
} from '@/lib/orders/create-order';
import { createOrderWithMercadoPago } from '@/lib/orders/create-order-with-mercado-pago';
import {
  getSavedCustomerAddress,
  saveContactOrderFields,
} from '@/lib/orders/text-order-flow';
import { PEDIDO_EMPANADAS_FLOW } from './pedido-empanadas-flow';
import { loadOrderCatalog } from '@/lib/orders/order-catalog';
import { isCompleteDeliveryAddress } from '@/lib/orders/text-order-parser';
import { groundCatalogOrder } from './catalog-order';
import type { Item } from '@/lib/orders/create-order-with-mercado-pago';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
  engineSendPayment,
} from './meta-send';
import { decideFallback, resolveFallbackPolicy } from './fallback';
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type CustomActionNodeConfig,
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
  type SetVarNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from './types';

// ============================================================
// Pure helpers
// ============================================================

export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string
): string | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? 'contains';
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (
      matchType === 'exact' ? haystack === needle : haystack.includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === 'start' ||
    node_type === 'send_message' ||
    node_type === 'send_media' ||
    node_type === 'condition' ||
    node_type === 'set_tag' ||
    node_type === 'set_var' ||
    node_type === 'custom_action'
  );
}

export function isSuspending(node_type: string): boolean {
  return (
    node_type === 'send_buttons' ||
    node_type === 'send_list' ||
    node_type === 'collect_input'
  );
}

export function isTerminal(node_type: string): boolean {
  return node_type === 'handoff' || node_type === 'end';
}

export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig['operator'];
  subjectValue: string | undefined;
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case 'present':
      return args.subjectValue !== undefined && args.subjectValue !== '';
    case 'absent':
      return args.subjectValue === undefined || args.subjectValue === '';
    case 'equals':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? '');
    case 'contains':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? '');
  }
}

// ============================================================
// DB Helpers & Interpolação Segura
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

/**
 * ⚠️ [CORREÇÃO]: Interpola variáveis {{vars.nome}} e {{nome}} em qualquer texto
 */
function interpolateVars(
  template: string,
  vars: Record<string, unknown>
): string {
  if (!template) return '';
  return template.replace(/\{\{(?:vars\.)?([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function normalizeButtonReply(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^[^a-z0-9]+/, '')
    .trim();
}

function hasGroundedCatalogOrder(vars: Record<string, unknown>): boolean {
  if (
    vars.catalog_order_version !== 1 ||
    !Array.isArray(vars.itens) ||
    !vars.itens.length
  )
    return false;
  let totalCents = 0;
  for (const raw of vars.itens) {
    if (!raw || typeof raw !== 'object') return false;
    const item = raw as Item;
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      typeof item.description !== 'string' ||
      !item.description.trim() ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice <= 0
    )
      return false;
    const cents = Math.round(item.unitPrice * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) return false;
    totalCents += cents * item.quantity;
  }
  return (
    Number.isSafeInteger(totalCents) &&
    typeof vars.total === 'number' &&
    Math.round(vars.total * 100) === totalCents
  );
}

function formatBRLNumber(value: number): string {
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string
): Promise<FlowRunRow | null> {
  const { data, error } = await db
    .from('flow_runs')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`Active flow lookup failed: ${error.message}`);
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .maybeSingle();
  if (error) {
    throw new Error(`Flow lookup failed: ${error.message}`);
  }
  return (data as FlowRow | null) ?? null;
}

async function loadAllNodes(
  db: AdminClient,
  flowId: string
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from('flow_nodes')
    .select('*')
    .eq('flow_id', flowId);
  if (error) {
    console.error('[flows] loadAllNodes error:', error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | 'started'
    | 'node_entered'
    | 'message_sent'
    | 'reply_received'
    | 'fallback_fired'
    | 'handoff'
    | 'timeout'
    | 'error'
    | 'completed',
  node_key: string | null,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from('flow_run_events').insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    console.error('[flows] logEvent error:', error.message);
  }
}

async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string
): Promise<boolean> {
  const { data: runs, error: runsError } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (runsError) throw new Error('Inbound deduplication runs unavailable');
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count, error: eventsError } = await db
    .from('flow_run_events')
    .select('id', { count: 'exact', head: true })
    .in('flow_run_id', runIds)
    .eq('event_type', 'reply_received')
    .filter('payload->>meta_message_id', 'eq', metaMessageId);
  if (eventsError || count === null)
    throw new Error('Inbound deduplication events unavailable');
  return count > 0;
}

// Meta retries webhooks, so the same cart can arrive twice. The run it
// started records the order's wamid on its "started" event.
async function isOrderAlreadyStarted(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string
): Promise<boolean> {
  const { data: runs, error: runsError } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (runsError) throw new Error('Inbound deduplication runs unavailable');
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count, error: eventsError } = await db
    .from('flow_run_events')
    .select('id', { count: 'exact', head: true })
    .in('flow_run_id', runIds)
    .eq('event_type', 'started')
    .filter('payload->>meta_message_id', 'eq', metaMessageId);
  if (eventsError || count === null)
    throw new Error('Inbound deduplication events unavailable');
  return count > 0;
}

export async function ensureActiveCatalogFlow(
  db: AdminClient,
  accountId: string,
  userId: string
): Promise<FlowRow | null> {
  try {
    // 1. Procura se existe flow catalog_order ativo
    const { data: activeFlow } = await db
      .from('flows')
      .select('*')
      .eq('account_id', accountId)
      .eq('trigger_type', 'catalog_order')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (activeFlow) return activeFlow as FlowRow;

    // 2. Procura se existe um flow inativo para ativar
    const { data: existingFlow } = await db
      .from('flows')
      .select('*')
      .eq('account_id', accountId)
      .eq('trigger_type', 'catalog_order')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingFlow) {
      const { data: updated } = await db
        .from('flows')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', existingFlow.id)
        .select('*')
        .single();
      return (updated || { ...existingFlow, status: 'active' }) as FlowRow;
    }

    // 3. Se não existe, cria a partir do template PEDIDO_EMPANADAS_FLOW
    const { data: newFlow, error: flowErr } = await db
      .from('flows')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: PEDIDO_EMPANADAS_FLOW.name,
        description: PEDIDO_EMPANADAS_FLOW.description,
        status: 'active',
        trigger_type: 'catalog_order',
        trigger_config: PEDIDO_EMPANADAS_FLOW.trigger_config ?? {},
        entry_node_id: PEDIDO_EMPANADAS_FLOW.entry_node_id,
      })
      .select('*')
      .single();

    if (flowErr || !newFlow) {
      console.error(
        '[engine] Erro ao provisionar flow catalog_order:',
        flowErr
      );
      return null;
    }

    const nodeRows = PEDIDO_EMPANADAS_FLOW.nodes.map((n) => ({
      flow_id: newFlow.id,
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config,
    }));

    const { error: nodesErr } = await db.from('flow_nodes').insert(nodeRows);
    if (nodesErr) {
      console.error(
        '[engine] Erro ao inserir nós do flow catalog_order:',
        nodesErr
      );
    }

    return newFlow as FlowRow;
  } catch (err) {
    console.error(
      '[engine] Falha inesperada ao garantir flow de catálogo:',
      err
    );
    return null;
  }
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  userId?: string
): Promise<FlowRow | null> {
  if (message.kind === 'interactive_reply') return null;

  const { data: flows, error } = await db
    .from('flows')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error || !flows) {
    console.error('[engine] findEntryFlow error:', error);
    return null;
  }

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === 'catalog_order') {
      if (message.kind === 'catalog_order') {
        return flow;
      }
    } else if (flow.trigger_type === 'keyword') {
      if (
        message.kind === 'text' &&
        matchesKeywordTrigger(
          message.text,
          flow.trigger_config as KeywordTriggerConfig
        )
      ) {
        return flow;
      }
    } else if (
      flow.trigger_type === 'first_inbound_message' &&
      isFirstInbound
    ) {
      if (message.kind === 'text') {
        return flow;
      }
    }
  }

  // Se for pedido de catálogo e nenhum flow estiver ativo na conta, provisiona e ativa automaticamente
  if (message.kind === 'catalog_order' && userId) {
    const autoFlow = await ensureActiveCatalogFlow(db, accountId, userId);
    if (autoFlow) return autoFlow;
  }

  return null;
}

// ============================================================
// Executores de Nós
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<{ outcome: 'advanced'; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;

  // ⚠️ [CORREÇÃO]: Interpola variáveis no texto, cabeçalho e rodapé dos botões
  const bodyText = interpolateVars(cfg.text, run.vars);
  const headerText = cfg.header_text
    ? interpolateVars(cfg.header_text, run.vars)
    : undefined;
  const footerText = cfg.footer_text
    ? interpolateVars(cfg.footer_text, run.vars)
    : undefined;

  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    headerText,
    footerText,
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });

  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_buttons',
    whatsapp_message_id,
  });

  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();

  await transitionFlowRun(
    db,
    run,
    {
      current_node_key: node.node_key,
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    },
    whatsapp_message_id
  );

  return { outcome: 'advanced', node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<{ outcome: 'advanced'; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;

  // ⚠️ [CORREÇÃO]: Interpola variáveis na lista interativa
  const bodyText = interpolateVars(cfg.text, run.vars);
  const headerText = cfg.header_text
    ? interpolateVars(cfg.header_text, run.vars)
    : undefined;
  const footerText = cfg.footer_text
    ? interpolateVars(cfg.footer_text, run.vars)
    : undefined;

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    buttonLabel: cfg.button_label,
    headerText,
    footerText,
    sections: cfg.sections.map((s) => ({
      title: s.title ? interpolateVars(s.title, run.vars) : undefined,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: r.description
          ? interpolateVars(r.description, run.vars)
          : undefined,
      })),
    })),
  });

  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_list',
    whatsapp_message_id,
  });

  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();

  await transitionFlowRun(
    db,
    run,
    {
      current_node_key: node.node_key,
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    },
    whatsapp_message_id
  );

  return { outcome: 'advanced', node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: Pick<FlowNodeRow, 'node_key' | 'config'>
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  if (
    !(await transitionFlowRun(db, run, {
      status: 'handed_off',
      end_reason: 'handoff_node',
      ...(cfg.assign_to ? { assigned_agent_id: cfg.assign_to } : {}),
    }))
  )
    return;
  const interpolatedNote = cfg.note
    ? interpolateVars(cfg.note, run.vars)
    : undefined;

  // The RPC queues the conversation in the same transaction as the run CAS.
  await logEvent(db, run.id, 'handoff', node.node_key, {
    note: interpolatedNote ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
}

async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === 'var') {
    const v = run.vars[cfg.subject_key];
    subjectValue =
      typeof v === 'string' ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === 'tag') {
    const { count } = await db
      .from('contact_tags')
      .select('contact_id', { count: 'exact', head: true })
      .eq('contact_id', run.contact_id!)
      .eq('tag_id', cfg.subject_key);
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ['name', 'email', 'phone', 'company'] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from('contacts')
      .select(cfg.subject_key)
      .eq('id', run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

async function endRun(
  db: AdminClient,
  run: FlowRunRow,
  status: 'completed' | 'handed_off' | 'timed_out' | 'failed',
  reason: string
): Promise<boolean> {
  return transitionFlowRun(db, run, { status, end_reason: reason });
}

// ============================================================
// Loop de Avanço Síncrono
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>
): Promise<{ outcome: 'advanced' | 'completed' | 'handed_off' }> {
  let currentKey: string | null = startNodeKey;
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, 'error', null, {
        reason: 'next_node_key was null mid-advance',
      });
      await endRun(db, run, 'failed', 'missing_next_node');
      return { outcome: 'completed' };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, 'error', currentKey, {
        reason: 'node_not_found',
      });
      await endRun(db, run, 'failed', 'node_not_found');
      return { outcome: 'completed' };
    }
    if (
      !(await transitionFlowRun(db, run, { current_node_key: node.node_key }))
    )
      return { outcome: 'advanced' };
    await logEvent(db, run.id, 'node_entered', node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === 'start') {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === 'send_message') {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const sendArgs = {
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
        };
        const { whatsapp_message_id } =
          node.node_key === 'link_pagamento'
            ? await engineSendPayment({
                ...sendArgs,
                bodyText: `La Empanadas — Pedido ${run.vars.order_id}\nTotal: ${formatBRLNumber(Number(run.vars.total))}\nPague com segurança pelo Mercado Pago.`,
                buttonUrl: String(run.vars.link_mercado_pago ?? ''),
                effectKey: `flow:${run.id}:payment`,
              })
            : await engineSendText({
                ...sendArgs,
                text: interpolateVars(cfg.text, run.vars),
              });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_message',
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_text_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        if (node.node_key === 'link_pagamento') {
          await executeHandoff(db, run, {
            ...node,
            config: {
              note: 'Envio de pagamento bloqueado ou incerto; reconciliar outbox antes de reenviar.',
            },
          });
          return { outcome: 'handed_off' };
        }
        await endRun(db, run, 'failed', 'send_text_failed');
        return { outcome: 'completed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'send_media') {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_media',
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_media_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run, 'failed', 'send_media_failed');
        return { outcome: 'completed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'collect_input') {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'collect_input',
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from('messages')
          .select('id')
          .eq('message_id', whatsapp_message_id)
          .maybeSingle();
        await transitionFlowRun(db, run, {
          last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'collect_input_prompt_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run, 'failed', 'collect_input_prompt_failed');
        return { outcome: 'completed' };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'condition') {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: 'true' | 'false';
      try {
        branch = (await evaluateConditionNode(db, run, cfg)) ? 'true' : 'false';
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'condition_evaluation_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run, 'failed', 'condition_evaluation_failed');
        return { outcome: 'completed' };
      }
      currentKey = branch === 'true' ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, 'node_entered', node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === 'set_tag') {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === 'add') {
          await db
            .from('contact_tags')
            .upsert(
              { contact_id: run.contact_id!, tag_id: cfg.tag_id },
              { onConflict: 'contact_id,tag_id' }
            );
        } else {
          await db
            .from('contact_tags')
            .delete()
            .eq('contact_id', run.contact_id!)
            .eq('tag_id', cfg.tag_id);
        }
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'set_tag_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'set_var') {
      const cfg = node.config as unknown as SetVarNodeConfig;
      try {
        if (cfg.var_key) {
          const interpolated = interpolateVars(cfg.value, run.vars);
          const newVars = { ...run.vars, [cfg.var_key]: interpolated };
          if (await writeFlowVars(db, run, newVars)) {
            await logEvent(db, run.id, 'node_entered', node.node_key, {
              var_key: cfg.var_key,
              var_value: interpolated,
            });
          } else {
            // A newer turn owns the run; never advance or hand off its state.
            return { outcome: 'advanced' };
          }
        }
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'set_var_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        return { outcome: 'advanced' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }

    // ============================================================
    // ⚡ AÇÃO CUSTOMIZADA: CRIAÇÃO DO PEDIDO + LINK DO MERCADO PAGO
    // ============================================================
    if (node.node_type === 'custom_action') {
      const cfg = node.config as unknown as CustomActionNodeConfig;

      let paymentLinkMissing = false;
      let checkoutClaimId: string | null = null;
      let checkoutFinishAttempted = false;
      let checkoutEvidence: Record<string, unknown> = {};
      if (cfg.action === 'create_order_deal') {
        if (
          !hasGroundedCatalogOrder(run.vars) ||
          run.vars.pedido_confirmado !== 'true'
        ) {
          await executeHandoff(db, run, {
            ...node,
            config: {
              note: 'Pedido não validado ou sem confirmação explícita. Revisar antes de cobrar.',
            },
          });
          return { outcome: 'handed_off' };
        }
        try {
          // Confirmation covers the displayed snapshot, not a changed or sold-out catalog.
          const currentCatalog = await loadOrderCatalog(db, run.account_id);
          const frozenItems = run.vars.itens as Item[];
          if (
            frozenItems.some((item) => {
              const current = currentCatalog.find(
                (entry) => entry.id === item.id
              );
              return (
                !current ||
                current.nome !== item.title ||
                current.preco !== item.unitPrice
              );
            })
          ) {
            await executeHandoff(db, run, {
              ...node,
              config: {
                note: 'Catálogo alterado após o resumo. Revisar disponibilidade/preços e obter nova confirmação antes de cobrar.',
              },
            });
            return { outcome: 'handed_off' };
          }
          const {
            nome,
            name,
            total,
            endereco,
            address,
            tipo_entrega,
            delivery_type,
            forma_pagamento,
            payment_method,
            itens,
          } = run.vars as Record<string, unknown>;

          const customerName = String(nome || name || 'Cliente');
          // The order flow records the choice with a set_var node. Older
          // flows don't, so a captured address also counts as delivery.
          const kind = tipo_entrega || delivery_type;
          const validDelivery: OrderDeliveryKind =
            kind === 'retirada'
              ? 'retirada'
              : kind === 'delivery' ||
                  String(endereco || address || '').trim().length > 0
                ? 'delivery'
                : 'retirada';
          const isDelivery = validDelivery === 'delivery';

          // Delivery is paid online only; pickup is paid at the counter.
          const validPayment: OrderPaymentMethod = !isDelivery
            ? 'na_retirada'
            : forma_pagamento === 'cartao' || payment_method === 'cartao'
              ? 'cartao'
              : forma_pagamento === 'pix' || payment_method === 'pix'
                ? 'pix'
                : 'mercado_pago';

          const orderTotal = Number(total || 0);
          const orderAddress =
            validDelivery === 'delivery'
              ? String(endereco || address || '')
              : undefined;
          if (isDelivery && !isCompleteDeliveryAddress(orderAddress ?? '')) {
            await executeHandoff(db, run, {
              ...node,
              config: {
                note: 'Endereço incompleto: obter Rua, Número e Bairro antes de cobrar.',
              },
            });
            return { outcome: 'handed_off' };
          }

          // One reference ties the Mercado Pago preference to the orders
          // row, which is how the MP webhook and the reminder cron find
          // the order once the customer pays. Uses a deterministic reference
          // tied to the flow run to guarantee idempotency.
          const externalReference =
            (run.vars.external_reference as string | undefined) ||
            `PED-${run.id.replace(/-/g, '').substring(0, 10)}`;
          const { data: contactRow } = await db
            .from('contacts')
            .select('phone')
            .eq('id', run.contact_id!)
            .maybeSingle();
          const payerPhone =
            (contactRow?.phone as string | undefined) ?? undefined;

          // Gera o Link do Mercado Pago e o Deal no CRM via createOrderWithMercadoPago ou createOrderDeal
          let mpUrl = (run.vars.link_mercado_pago as string | undefined) || '';
          let dealId: string | null =
            (run.vars.deal_id as string | undefined) ?? null;
          let orderId: string | null =
            (run.vars.order_id as string | undefined) ?? null;
          let tagName: string | undefined = undefined;

          // Grounded lines are frozen at intake; never infer titles or prices here.
          const mpItems = itens as Item[];

          // Linearization point AFTER catalog/contact I/O, BEFORE CRM/gateway.
          // The RPC locks the run and checks its exact snapshot and revision.
          checkoutClaimId = await authorizeFlowCheckout(db, run);
          if (!checkoutClaimId) return { outcome: 'advanced' };
          checkoutEvidence = { external_reference: externalReference };

          if (isDelivery && orderTotal > 0 && !mpUrl) {
            try {
              const mpRes = await createOrderWithMercadoPago(
                { accountId: run.account_id, userId: run.user_id },
                {
                  contactId: run.contact_id!,
                  customerName,
                  deliveryKind: 'delivery',
                  deliveryAddress: orderAddress,
                  items: mpItems,
                  externalReference,
                  conversationId: run.conversation_id ?? undefined,
                  payerPhone,
                }
              );

              checkoutEvidence = {
                ...checkoutEvidence,
                ...(mpRes.orderId ? { order_id: mpRes.orderId } : {}),
                ...(mpRes.dealId ? { deal_id: mpRes.dealId } : {}),
                ...(mpRes.link_mercado_pago
                  ? { link_mercado_pago: mpRes.link_mercado_pago }
                  : {}),
              };

              if (
                mpRes.ok &&
                mpRes.link_mercado_pago &&
                mpRes.orderId &&
                mpRes.dealId
              ) {
                mpUrl = mpRes.link_mercado_pago;
                dealId = mpRes.dealId ?? null;
                orderId = mpRes.orderId ?? null;
              } else {
                console.error(
                  '[flows] Falha ao criar link Mercado Pago:',
                  mpRes.error
                );
                if (mpRes.dealId) dealId = mpRes.dealId;
                paymentLinkMissing = true;
              }
            } catch (mpErr) {
              console.error('[flows] Erro createOrderWithMercadoPago:', mpErr);
              paymentLinkMissing = true;
            }
          } else if (!isDelivery && !dealId) {
            // Criação do card no Pipeline CRM para Retirada (ou fallback)
            const result = await createOrderDeal(
              supabaseAdmin(),
              { accountId: run.account_id, userId: run.user_id },
              {
                contactId: run.contact_id!,
                customerName,
                deliveryKind: validDelivery,
                paymentMethod: validPayment,
                items: mpItems,
                total: orderTotal,
                deliveryAddress: orderAddress,
                paidOnline: false,
                conversationId: run.conversation_id ?? undefined,
                external_reference: externalReference,
              }
            );
            dealId = result.dealId;
            tagName = result.tagName;
            orderId = result.orderId ?? null;
            checkoutEvidence = {
              ...checkoutEvidence,
              deal_id: dealId,
              order_id: orderId,
            };
            if (!orderId || !dealId)
              throw new Error(
                'Pickup requires a persisted canonical order and deal'
              );
          }

          if (isDelivery && (!mpUrl || !orderId || !dealId)) {
            paymentLinkMissing = true;
          }

          checkoutEvidence = {
            ...checkoutEvidence,
            ...(mpUrl ? { link_mercado_pago: mpUrl } : {}),
            ...(dealId ? { deal_id: dealId } : {}),
            ...(orderId ? { order_id: orderId } : {}),
          };
          // Preserve remote evidence even if a correction won ownership.
          // Started requests cannot be cancelled by writing false consent.
          checkoutFinishAttempted = true;
          if (
            !(await finishFlowCheckout(
              db,
              run,
              checkoutClaimId,
              checkoutEvidence,
              !paymentLinkMissing
            ))
          )
            return { outcome: 'handed_off' };

          // Salva os campos personalizados do contato (endereço, itens, forma de pagamento)
          if (run.contact_id) {
            await saveContactOrderFields(db, run.account_id, run.contact_id, {
              endereco: orderAddress,
              itens:
                typeof run.vars.itens_texto === 'string'
                  ? run.vars.itens_texto
                  : mpItems.map((i) => `${i.quantity}x ${i.title}`).join(', '),
              formaPagamento: isDelivery ? 'Mercado Pago' : 'Na Retirada',
              nomeCliente: customerName,
            });
          }

          // Persiste as referências de deal e pedido nas variáveis da execução

          await logEvent(db, run.id, 'node_entered', node.node_key, {
            action_type: 'create_order_deal',
            deal_id: dealId,
            tag: tagName,
            payment_url: mpUrl,
            external_reference: externalReference,
            order_id: orderId,
          });
        } catch (err) {
          console.error('[flows] create_order_deal error:', err);
          if (checkoutClaimId && !checkoutFinishAttempted) {
            try {
              checkoutFinishAttempted = true;
              await finishFlowCheckout(
                db,
                run,
                checkoutClaimId,
                {
                  ...checkoutEvidence,
                  error: err instanceof Error ? err.message : String(err),
                },
                false
              );
            } catch (evidenceError) {
              console.error(
                '[flows] blocking claim needs reconciliation:',
                evidenceError
              );
            }
          }
          await logEvent(db, run.id, 'error', node.node_key, {
            reason: 'create_order_deal_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          paymentLinkMissing = true;
        }
      }

      // Without a real checkout link the next node would send the
      // customer a payment message with nothing to pay. Tell them a
      // person will follow up and hand the conversation to the team.
      if (paymentLinkMissing) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'payment_link_unavailable',
        });
        await executeHandoff(db, run, {
          ...node,
          config: {
            note: 'Checkout bloqueado/incerto: reconciliar claim, pedido e gateway antes de qualquer cobrança ou reenvio. Cliente: {{vars.nome}} | Total: {{vars.total_formatado}}',
          },
        });
        return { outcome: 'handed_off' };
      }

      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.node_type === 'send_buttons') {
      await sendButtonsAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'send_list') {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'handoff') {
      await executeHandoff(db, run, node);
      return { outcome: 'handed_off' };
    }
    if (node.node_type === 'end') {
      await logEvent(db, run.id, 'completed', node.node_key);
      await endRun(db, run, 'completed', 'end_node');
      return { outcome: 'completed' };
    }
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run, 'failed', 'unknown_node_type');
    return { outcome: 'completed' };
  }
  await logEvent(db, run.id, 'error', currentKey, {
    reason: 'advance_loop_safety_break',
  });
  await endRun(db, run, 'failed', 'advance_loop_overflow');
  return { outcome: 'completed' };
}

async function advanceCurrentNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  expectedOldKey: string | null,
  newKey: string
): Promise<boolean> {
  if (run.current_node_key !== expectedOldKey) return false;
  return transitionFlowRun(db, run, { current_node_key: newKey });
}

// ============================================================
// Ponto de Entrada Público (Chamado pelo Webhook)
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean }
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId
    );

    if (
      input.message.kind === 'catalog_order' &&
      (await isOrderAlreadyStarted(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id
      ))
    ) {
      return {
        consumed: true,
        flow_run_id: activeRun?.id,
        outcome: 'duplicate_inbound_ignored',
      };
    }

    // A catalog order is a fresh purchase intent, never a reply to the
    // node the contact is parked on. Without this, a contact who
    // abandoned an earlier run (e.g. never answered "Qual é o seu
    // nome?") has every new cart swallowed as a failed reply to that
    // stale node, so the order flow never starts and no payment link
    // is generated. End the stale run and let the order flow match.
    if (activeRun && input.message.kind === 'catalog_order') {
      await logEvent(db, activeRun.id, 'error', activeRun.current_node_key, {
        reason: 'superseded_by_catalog_order',
        meta_message_id: input.message.meta_message_id,
      });
      if (
        !(await endRun(db, activeRun, 'failed', 'superseded_by_catalog_order'))
      )
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: 'advanced',
        };
    } else if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: 'duplicate_inbound_ignored',
        };
      }
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return await handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      input.userId
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: 'no_match' };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return await startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      '[flows] dispatchInboundToFlows threw:',
      err instanceof Error ? err.message : err
    );
    // Storage uncertainty must not release this inbound to another order processor.
    return { consumed: true, outcome: 'handed_off' };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>
): Promise<DispatchInboundResult> {
  const flow = await loadFlow(db, run.flow_id);
  if (
    flow?.trigger_type === 'catalog_order' &&
    !hasGroundedCatalogOrder(run.vars)
  ) {
    await executeHandoff(db, run, {
      node_key: run.current_node_key ?? 'legacy_catalog',
      config: {
        note: 'Pedido legado sem linhas validadas: revisar integralmente antes de cobrar.',
      },
    });
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  await logEvent(db, run.id, 'reply_received', run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === 'interactive_reply' ? message.reply_id : null,
    text_length: message.kind === 'text' ? message.text.length : null,
  });

  if (!run.current_node_key) {
    await endRun(db, run, 'failed', 'active_run_missing_current_node');
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: 'no_match',
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run, 'failed', 'current_node_not_found');
    return { consumed: true, flow_run_id: run.id, outcome: 'no_match' };
  }

  if (
    flow?.trigger_type === 'catalog_order' &&
    message.kind === 'text' &&
    /\b(troca\w*|alter\w*|corrig\w*|cancel\w*|adicion\w*|remov\w*|sem|observa\w*)\b/.test(
      normalizeButtonReply(message.text)
    )
  ) {
    await correctFlowCheckout(db, run, message.text);
    await executeHandoff(db, run, {
      ...currentNode,
      config: {
        note: 'Cliente pediu revisão; texto integral preservado. Se checkout já iniciado, reconciliar claim e gateway; não presumir cancelamento.',
      },
    });
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  let matched: string | null = null;
  if (
    message.kind === 'interactive_reply' &&
    (currentNode.node_type === 'send_buttons' ||
      currentNode.node_type === 'send_list')
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === 'text' &&
    currentNode.node_type === 'send_buttons'
  ) {
    // Permite que o cliente responda em texto simples aos botões (ex: "delivery", "retirar", "confirmar", etc.)
    const cfg = currentNode.config as unknown as SendButtonsNodeConfig;
    const norm = normalizeButtonReply(message.text);
    const hit = cfg.buttons?.find((b) => {
      const aliases: Record<string, string[]> = {
        mesmo_endereco: ['sim', 'mesmo endereco', 'confirmar'],
        delivery: ['delivery', 'entrega'],
        retirada: ['retirada', 'retirar', 'retirar na loja'],
        confirmar_pedido: ['confirmar', 'confirmar pedido', 'sim', 'confirmo'],
        corrigir_pedido: ['corrigir', 'corrigir pedido'],
      };
      return (
        norm === normalizeButtonReply(b.reply_id) ||
        norm === normalizeButtonReply(b.title) ||
        (aliases[b.reply_id] ?? []).includes(norm)
      );
    });
    if (hit) matched = hit.next_node_key;
  } else if (
    message.kind === 'text' &&
    currentNode.node_type === 'collect_input'
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (
      flow?.trigger_type === 'catalog_order' &&
      cfg.var_key === 'endereco' &&
      !isCompleteDeliveryAddress(captured)
    ) {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: 'Envie o endereço completo (Rua, Número e Bairro) antes de confirmar o pedido.',
      });
      return { consumed: true, flow_run_id: run.id, outcome: 'advanced' };
    }
    if (captured.length > 0 && cfg.var_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      if (await writeFlowVars(db, run, newVars)) {
        run.reprompt_count = 0;
        await logEvent(db, run.id, 'node_entered', currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      } else {
        return { consumed: true, flow_run_id: run.id, outcome: 'advanced' };
      }
    }
  }

  if (matched) {
    const confirmationGate =
      currentNode.node_type === 'send_buttons' &&
      (currentNode.config as unknown as SendButtonsNodeConfig).buttons.some(
        (button) =>
          button.reply_id === 'confirmar_pedido' &&
          button.next_node_key === matched
      );
    if (confirmationGate && !(await confirmFlowCheckout(db, run, message))) {
      if (!run.consent_prompt_message) {
        await executeHandoff(db, run, {
          node_key: currentNode.node_key,
          config: {
            note: 'Resumo legado sem evidência de consentimento. Revisar o snapshot integral e obter nova confirmação antes de cobrar.',
          },
        });
        return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
      }
      return { consumed: true, flow_run_id: run.id, outcome: 'advanced' };
    }
    if (run.reprompt_count !== 0) {
      if (!(await transitionFlowRun(db, run, { reprompt_count: 0 })))
        return { consumed: true, flow_run_id: run.id, outcome: 'advanced' };
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy
  );
  const newReprompts = run.reprompt_count + 1;
  if (!(await transitionFlowRun(db, run, { reprompt_count: newReprompts })))
    return { consumed: true, flow_run_id: run.id, outcome: 'advanced' };

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, 'fallback_fired', run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === 'ignore') {
    return { consumed: false, flow_run_id: run.id, outcome: 'no_match' };
  }
  if (action.type === 'reprompt') {
    if (currentNode.node_type === 'send_buttons') {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === 'send_list') {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === 'collect_input') {
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', currentNode.node_key, {
          reason: 'reprompt_send_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: 'fallback_fired' };
  }
  if (action.type === 'handoff') {
    await executeHandoff(db, run, {
      node_key: run.current_node_key!,
      config: { note: 'fallback_exhausted' },
    });
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  await endRun(db, run, 'completed', 'fallback_exhausted_end');
  return { consumed: true, flow_run_id: run.id, outcome: 'completed' };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>
): Promise<DispatchInboundResult> {
  let seedVars: Record<string, unknown> = {};
  let catalogError: string | null = null;
  if (input.message.kind === 'catalog_order') {
    try {
      const grounded = groundCatalogOrder(
        input.message.items,
        await loadOrderCatalog(db, input.accountId),
        input.message.notes
      );
      const summary = grounded.items
        .map(
          (it) =>
            `• ${it.quantity}x ${it.title} — ${formatBRLNumber(it.quantity * it.unitPrice)}`
        )
        .join('\n');
      seedVars = {
        catalog_order_version: 1,
        itens: grounded.items,
        itens_lista: summary,
        itens_texto: summary,
        total: grounded.total,
        total_formatado: formatBRLNumber(grounded.total),
        observacoes: 'Nenhuma',
        catalog_inbound: input.message,
      };
      if (!hasGroundedCatalogOrder(seedVars))
        throw new Error(
          'Pedido com valores fora dos limites monetários seguros.'
        );
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
      seedVars = {
        catalog_inbound: input.message,
        catalog_error: catalogError,
      };
    }
    // The WhatsApp profile name, so the flow doesn't have to ask for it.
    const { data: contact } = await db
      .from('contacts')
      .select('name')
      .eq('id', input.contactId)
      .maybeSingle();
    const contactName = String(contact?.name ?? '').trim();

    // Endereço salvo: verifica contact_custom_values, pedidos anteriores e anotações de deals
    const savedAddress = await getSavedCustomerAddress(
      db,
      input.accountId,
      input.contactId
    );
    const lastAddress = (savedAddress ?? '').trim();
    seedVars = {
      ...seedVars,
      ...(contactName ? { nome: contactName } : {}),
      ...(lastAddress ? { ultimo_endereco: lastAddress } : {}),
    };
  }

  const { data: inserted, error: insErr } = await db
    .from('flow_runs')
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: 'active',
      current_node_key: flow.entry_node_id,
      vars: seedVars,
    })
    .select('*')
    .maybeSingle();
  if (insErr) {
    const msg = insErr.message ?? '';
    if (msg.includes('23505') || msg.includes('duplicate key')) {
      return { consumed: true, outcome: 'duplicate_inbound_ignored' };
    }
    console.error('[flows] startNewRun insert error:', insErr.message);
    return { consumed: false, outcome: 'no_match' };
  }
  if (!inserted) return { consumed: true, outcome: 'handed_off' };
  const run = inserted as FlowRunRow;
  if (catalogError) {
    await executeHandoff(db, run, {
      node_key: 'catalog_review',
      config: {
        note: `Revisar pedido integral preservado em catalog_inbound: ${catalogError}`,
      },
    });
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  await logEvent(db, run.id, 'started', flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  const { error: incErr } = await db.rpc('increment_flow_execution_count', {
    p_flow_id: flow.id,
  });
  if (incErr) {
    console.error('[flows] execution_count rpc error:', incErr.message);
  }

  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === 'advanced' ? 'started' : outcome.outcome,
  };
}
