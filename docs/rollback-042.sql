-- ARTEFATO DE OPERACAO MANUAL: NAO EXECUTADO por esta analise.
-- Fora de supabase/migrations: nao aplicar automaticamente nem registrar como migration.
-- Requer autorizacao explicita de banco e coordenacao com os consumidores do webhook.
-- Origem exata do bloco abaixo: 039_conversation_handoff.sql, linhas 60-116,
-- identico em 2966071, 782d6c6 e 4477db3.
-- Restaura SOMENTE handle_conversation_handoff (assinatura, corpo e permissoes).
-- MANTER public.conversations.bot_order_resumed_at e TODOS os seus dados:
-- o codigo 782d6c6/fase2 seleciona essa coluna e falha se ela for removida.
-- Nao altera outras funcoes, triggers, notificacoes, pedidos, claims ou historico.
-- Nao desfaz retomadas ja persistidas: pausas/episodios apagados pela 042 nao sao
-- reconstruidos; o timestamp preservado ainda influencia os gates TypeScript.
-- A RPC039 volta a ignorar esse timestamp e restringe p_new_order conforme 039.
-- Com codigo novo, isso reintroduz bloqueios de pedidos durante pausas/humano ativo;
-- nao considerar este rollback equivalencia funcional nem recuperacao de estado.
-- Antes da operacao: revisar estado real, versao de todos os writers e mensagens
-- em voo; coordenar pausa/drenagem e reconciliacao manual quando necessario.
-- BEGIN/COMMIT abaixo apenas delimitam a transacao para eventual operador autorizado.
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_conversation_handoff(
  p_account_id uuid,p_conversation_id uuid,p_contact_id uuid,p_request boolean DEFAULT false,
  p_reason text DEFAULT 'customer_request',p_resume boolean DEFAULT false,p_new_order boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.conversations; active_human boolean; reason text;
BEGIN
  IF p_reason NOT IN ('customer_request','order_review','payment_review','technical_error','human_active','manual') THEN
    RAISE EXCEPTION 'Invalid handoff reason';
  END IF;
  SELECT * INTO c FROM public.conversations WHERE account_id=p_account_id AND id=p_conversation_id AND contact_id=p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation/contact does not belong to account'; END IF;
  active_human := c.last_agent_message_at IS NOT NULL AND c.last_agent_message_at > now()-interval '30 minutes';
  IF p_new_order AND NOT p_request AND NOT active_human AND c.bot_pause_reason IN ('order_review','payment_review','human_active')
    AND EXISTS (
      SELECT 1 FROM public.order_drafts d LEFT JOIN public.orders o ON o.account_id=d.account_id
        AND o.external_reference=coalesce(d.state->>'paymentReference',concat('TEXT-',d.state->>'id','-',d.state->>'version'))
      WHERE d.account_id=p_account_id AND d.conversation_id=p_conversation_id
        AND (o.status IN ('paid','payment_approved','completed','cancelled') OR (o.id IS NULL
          AND d.state->>'stage' <> 'payment_created'
          AND coalesce((d.state->>'cartUpdatedAt')::timestamptz,d.updated_at)<=now()-interval '24 hours'))
        AND NOT EXISTS(SELECT 1 FROM public.order_checkouts oc WHERE oc.account_id=p_account_id
          AND oc.external_reference=coalesce(d.state->>'paymentReference',concat('TEXT-',d.state->>'id','-',d.state->>'version')) AND oc.status<>'completed')
    ) THEN
    UPDATE public.conversations SET ai_autoreply_disabled=false,status='open',ai_reply_count=0,
      bot_pause_reason=NULL,bot_paused_at=NULL,bot_resume_after=NULL,bot_handoff_id=NULL
    WHERE id=c.id AND account_id=p_account_id;
    RETURN jsonb_build_object('blocked',false,'resumed',true);
  END IF;
  IF NOT p_request AND NOT c.ai_autoreply_disabled AND NOT active_human AND c.status <> 'pending' THEN
    RETURN jsonb_build_object('blocked',false);
  END IF;
  IF c.bot_handoff_id IS NULL OR NOT c.ai_autoreply_disabled THEN
    reason := CASE WHEN p_request THEN p_reason WHEN active_human THEN 'human_active' ELSE coalesce(c.bot_pause_reason,'order_review') END;
    UPDATE public.conversations SET ai_autoreply_disabled=true,status='pending',
      bot_pause_reason=reason,bot_handoff_id=gen_random_uuid(),bot_paused_at=now(),bot_resume_after=now()+interval '30 minutes'
    WHERE id=c.id AND account_id=p_account_id RETURNING * INTO c;
    UPDATE public.flow_runs SET status='handed_off',ended_at=now(),end_reason='conversation_handoff'
    WHERE account_id=p_account_id AND conversation_id=c.id AND status='active';
  ELSIF p_request AND c.bot_pause_reason <> 'manual' THEN
    UPDATE public.conversations SET bot_pause_reason=CASE
      WHEN p_reason IN ('customer_request','payment_review','technical_error') THEN p_reason ELSE bot_pause_reason END
    WHERE id=c.id AND account_id=p_account_id RETURNING * INTO c;
  END IF;
  IF NOT active_human AND c.bot_pause_reason IS DISTINCT FROM 'manual'
    AND NOT p_request AND c.bot_resume_after IS NOT NULL AND now()>=c.bot_resume_after THEN
    IF c.bot_pause_reason IN ('customer_request','payment_review','technical_error') AND NOT p_resume THEN
      RETURN jsonb_build_object('blocked',true,'episode_id',c.bot_handoff_id,'notice','resume');
    END IF;
    UPDATE public.conversations SET ai_autoreply_disabled=false,status='open',ai_reply_count=0,
      bot_pause_reason=NULL,bot_paused_at=NULL,bot_resume_after=NULL,bot_handoff_id=NULL
    WHERE id=c.id AND account_id=p_account_id;
    RETURN jsonb_build_object('blocked',false,'resumed',true);
  END IF;
  RETURN jsonb_build_object('blocked',true,'episode_id',c.bot_handoff_id,'notice','waiting');
END $$;
REVOKE ALL ON FUNCTION public.handle_conversation_handoff(uuid,uuid,uuid,boolean,text,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.handle_conversation_handoff(uuid,uuid,uuid,boolean,text,boolean,boolean) TO service_role;

COMMIT;
