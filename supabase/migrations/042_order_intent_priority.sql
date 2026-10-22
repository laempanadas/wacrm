-- Only service-role callers that validated explicit quantities against the
-- account catalog may set p_new_order. This resumes routing, never checkout.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS bot_order_resumed_at timestamptz;

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
  -- Preserve the human-send history. Only a known send strictly before a valid
  -- resumption is superseded; equal/future timestamps remain conservative.
  active_human := c.last_agent_message_at IS NOT NULL
    AND c.last_agent_message_at > now()-interval '30 minutes'
    AND NOT (c.bot_order_resumed_at IS NOT NULL AND c.bot_order_resumed_at <= now()
      AND c.last_agent_message_at < c.bot_order_resumed_at);
  IF p_new_order AND NOT p_request THEN
    UPDATE public.conversations SET ai_autoreply_disabled=false,status='open',ai_reply_count=0,
      bot_pause_reason=NULL,bot_paused_at=NULL,bot_resume_after=NULL,bot_handoff_id=NULL,
      bot_order_resumed_at=now()
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
