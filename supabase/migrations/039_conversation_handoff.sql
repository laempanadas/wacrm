-- Local migration only. Durable handoff episodes, team notifications and safe resume.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS bot_pause_reason text,
  ADD COLUMN IF NOT EXISTS bot_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS bot_resume_after timestamptz,
  ADD COLUMN IF NOT EXISTS bot_handoff_id uuid;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'human_attention_required'));
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS handoff_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_handoff_recipient
  ON public.notifications(account_id, user_id, handoff_id)
  WHERE handoff_id IS NOT NULL;

-- Also cover older writers that only set the flag. Unknown/manual pauses are
-- deliberately not auto-expired; inferred legacy state is handled on inbound.
CREATE OR REPLACE FUNCTION public.prepare_bot_handoff()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.ai_autoreply_disabled AND (NOT OLD.ai_autoreply_disabled OR NEW.bot_handoff_id IS NULL) THEN
    IF NEW.bot_handoff_id IS NULL OR NEW.bot_handoff_id IS NOT DISTINCT FROM OLD.bot_handoff_id THEN
      NEW.bot_handoff_id := gen_random_uuid();
    END IF;
    NEW.bot_pause_reason := coalesce(NEW.bot_pause_reason,'manual');
    NEW.bot_paused_at := coalesce(NEW.bot_paused_at,now());
    IF NEW.bot_pause_reason <> 'manual' THEN NEW.bot_resume_after := coalesce(NEW.bot_resume_after,now()+interval '30 minutes'); END IF;
    NEW.status := 'pending';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prepare_bot_handoff ON public.conversations;
CREATE TRIGGER prepare_bot_handoff BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.prepare_bot_handoff();

CREATE OR REPLACE FUNCTION public.notify_bot_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE recipient uuid;
BEGIN
  IF NOT NEW.ai_autoreply_disabled OR NEW.bot_handoff_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.bot_handoff_id IS NOT DISTINCT FROM OLD.bot_handoff_id THEN RETURN NEW; END IF;
  FOR recipient IN
    SELECT p.user_id FROM public.profiles p WHERE p.account_id=NEW.account_id
      AND p.account_role IN ('owner','admin','agent')
      AND (p.user_id=NEW.assigned_agent_id OR (NEW.assigned_agent_id IS NULL AND p.account_role IN ('owner','admin')))
    UNION
    SELECT a.owner_user_id FROM public.accounts a WHERE a.id=NEW.account_id AND NEW.assigned_agent_id IS NULL
  LOOP
    INSERT INTO public.notifications(account_id,user_id,type,conversation_id,contact_id,actor_user_id,title,body,read_at,handoff_id)
    VALUES (NEW.account_id,recipient,'human_attention_required',NEW.id,NEW.contact_id,NULL,
      'Atendimento necessário',
      concat('Motivo: ',NEW.bot_pause_reason,'. Última mensagem: ',left(coalesce(NEW.last_message_text,''),250)),NULL,NEW.bot_handoff_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_bot_handoff ON public.conversations;
CREATE TRIGGER on_bot_handoff AFTER UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.notify_bot_handoff();

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
REVOKE ALL ON FUNCTION public.notify_bot_handoff() FROM PUBLIC,anon,authenticated;

-- Existing catalog consent RPCs already call this function under their lock.
CREATE OR REPLACE FUNCTION public.flow_checkout_queue(p_account_id uuid,p_run_id uuid,p_conversation_id uuid,p_assign uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.conversations SET status='pending',updated_at=now(),
    assigned_agent_id=coalesce(p_assign,assigned_agent_id),ai_autoreply_disabled=true,
    bot_pause_reason=coalesce(bot_pause_reason,'order_review'),
    bot_handoff_id=coalesce(bot_handoff_id,p_run_id),bot_paused_at=coalesce(bot_paused_at,now()),
    bot_resume_after=coalesce(bot_resume_after,now()+interval '30 minutes')
  WHERE account_id=p_account_id AND id=p_conversation_id
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs WHERE account_id=p_account_id AND conversation_id=p_conversation_id AND id<>p_run_id AND status='active');
END $$;
REVOKE ALL ON FUNCTION public.flow_checkout_queue(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;

-- Preserve legacy cart age under the same turn lock before refreshing updated_at.
-- Keep 036's ownership, event deduplication and non-reclaimable busy turns intact.
CREATE OR REPLACE FUNCTION public.claim_order_turn(
  p_account_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_message_id text, p_text text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE draft public.order_drafts; inserted integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'Conversation/contact does not belong to account';
  END IF;
  INSERT INTO public.order_inbound_events(account_id, meta_message_id, conversation_id, raw_text, status)
    VALUES (p_account_id, p_message_id, p_conversation_id, p_text, 'processing') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;
  INSERT INTO public.order_drafts(account_id, conversation_id, contact_id)
    VALUES (p_account_id, p_conversation_id, p_contact_id) ON CONFLICT (account_id, conversation_id) DO NOTHING;
  SELECT * INTO draft FROM public.order_drafts WHERE account_id = p_account_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF draft.processing_message_id IS NOT NULL THEN
    UPDATE public.order_inbound_events SET status = 'blocked' WHERE account_id = p_account_id AND meta_message_id = p_message_id;
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;
  UPDATE public.order_drafts SET
    state = CASE WHEN state->>'cartUpdatedAt' IS NULL
      THEN jsonb_set(state, '{cartUpdatedAt}', to_jsonb(updated_at)) ELSE state END,
    processing_message_id = p_message_id, updated_at = now()
  WHERE id = draft.id RETURNING * INTO draft;
  RETURN jsonb_build_object('outcome', 'claimed', 'id', draft.id, 'state', draft.state);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_order_turn(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_turn(uuid, uuid, uuid, text, text) TO service_role;

-- Archive old state without dropping orders, gateway bindings or uncertain claims.
CREATE TABLE IF NOT EXISTS public.order_draft_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.accounts(id),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id), state jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_draft_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_draft_history FROM anon,authenticated;
GRANT ALL ON public.order_draft_history TO service_role;
CREATE OR REPLACE FUNCTION public.rotate_order_draft(
  p_account_id uuid,p_conversation_id uuid,p_message_id text,p_snapshot jsonb,p_explicit_new boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.order_drafts; o public.orders; ref text; fresh jsonb;
BEGIN
  SELECT * INTO d FROM public.order_drafts WHERE account_id=p_account_id AND conversation_id=p_conversation_id FOR UPDATE;
  IF NOT FOUND OR d.processing_message_id IS DISTINCT FROM p_message_id OR d.state IS DISTINCT FROM p_snapshot THEN
    RAISE EXCEPTION 'Draft turn changed';
  END IF;
  ref := coalesce(d.state->>'paymentReference',concat('TEXT-',d.state->>'id','-',d.state->>'version'));
  SELECT * INTO o FROM public.orders WHERE account_id=p_account_id AND external_reference=ref FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.order_checkouts WHERE account_id=p_account_id AND external_reference=ref AND status<>'completed')
    OR o.status IN ('checkout_processing','checkout_uncertain') THEN RAISE EXCEPTION 'Checkout requires reconciliation'; END IF;
  IF o.id IS NOT NULL AND o.status NOT IN ('paid','payment_approved','completed','cancelled') AND NOT p_explicit_new THEN
    RAISE EXCEPTION 'Open payment must be preserved';
  END IF;
  IF o.id IS NULL AND NOT p_explicit_new AND coalesce((d.state->>'cartUpdatedAt')::timestamptz,d.updated_at)>now()-interval '24 hours' THEN
    RAISE EXCEPTION 'Draft is still current';
  END IF;
  INSERT INTO public.order_draft_history(account_id,conversation_id,state) VALUES(p_account_id,p_conversation_id,d.state);
  fresh := jsonb_build_object('id',gen_random_uuid(),'version',0,'items','[]'::jsonb,'unresolved','[]'::jsonb,'stage','collecting','total',0,'cartUpdatedAt',now());
  UPDATE public.order_drafts SET state=fresh,updated_at=now() WHERE id=d.id;
  RETURN fresh;
END $$;
REVOKE ALL ON FUNCTION public.rotate_order_draft(uuid,uuid,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_order_draft(uuid,uuid,text,jsonb,boolean) TO service_role;
