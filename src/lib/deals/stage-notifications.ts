/**
 * stage-notifications.ts
 *
 * Envia notificações automáticas no WhatsApp quando o deal muda de stage.
 * Integra com engineSendText para enviar mensagens na conversa ativa.
 *
 * COST OPTIMIZATION: Usa templates condensados da Meta para minimizar cobrança por mensagem.
 * Máximo de 2 mensagens por pedido (confirmação → entrega).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { engineSendText } from '@/lib/flows/meta-send';
import {
  PIPELINE_STAGES,
  type PipelineStage,
} from '@/lib/orders/pipeline-stages';
import {
  TEMPLATE_PEDIDO_NA_COZINHA,
  TEMPLATE_SAIU_ENTREGA,
} from '@/lib/orders/delivery-templates';

interface StageNotificationParams {
  db: SupabaseClient;
  accountId: string;
  dealId: string;
  contactId: string;
  newStage: PipelineStage;
}

/**
 * Mapeamento de stage para mensagem WhatsApp.
 * Usa templates condensados para otimizar custos com Meta.
 *
 * ESTRATÉGIA DE 2 MENSAGENS:
 * 1. "Na Cozinha": Confirmação de pagamento + entrada do pedido
 * 2. "Pronto para Entrega": Notificação de saída
 * 3. "Entregue": SEM mensagem (economiza cobrança da Meta)
 */
const STAGE_MESSAGES: Record<string, string | null> = {
  [PIPELINE_STAGES.COOKING]: TEMPLATE_PEDIDO_NA_COZINHA,
  [PIPELINE_STAGES.READY]: TEMPLATE_SAIU_ENTREGA,
  [PIPELINE_STAGES.DELIVERED]: null, // Sem mensagem — economiza cobrança
};

/**
 * Envia notificação automática ao cliente quando deal muda de stage.
 * Best-effort: erros são logados mas não interrompem o fluxo.
 */
export async function sendStageNotification(
  params: StageNotificationParams
): Promise<void> {
  const { db, accountId, dealId, contactId, newStage } = params;

  const message = STAGE_MESSAGES[newStage];
  if (!message) {
    // Stage sem notificação configurada
    return;
  }

  try {
    // Busca conversa ativa do contato
    const { data: conversation, error: convErr } = await db
      .from('conversations')
      .select('id, user_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (convErr || !conversation) {
      console.warn(
        '[stage-notifications] no active conversation for contact:',
        contactId
      );
      return;
    }

    // Envia mensagem na conversa ativa
    await engineSendText({
      accountId,
      userId: conversation.user_id ?? '',
      conversationId: conversation.id,
      contactId,
      text: message,
    });

    console.log('[stage-notifications] sent for stage:', {
      dealId,
      stage: newStage,
      conversationId: conversation.id,
    });
  } catch (err) {
    console.error('[stage-notifications] failed to send:', err);
    // Non-blocking: continue with deal movement
  }
}
