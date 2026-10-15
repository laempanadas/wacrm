-- Atomic catalog-flow consent. Apply through the normal migration process only.
-- All protocol functions serialize on one tenant-scoped run; claims never expire.
BEGIN;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_prompt_snapshot jsonb;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_prompt_node text;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_prompt_message text;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_confirmed_snapshot jsonb;
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS consent_inbound_message text;
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_account_identity ON public.flow_runs(account_id,id);
-- A consumed inbound cannot confirm a later summary (even before any checkout
-- claim exists). The service records the exact displayed snapshot once.
CREATE TABLE IF NOT EXISTS public.flow_checkout_confirmations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES public.accounts(id),
 run_id uuid NOT NULL,
 inbound_message text NOT NULL CHECK (length(inbound_message)>0),
 prompt_message text NOT NULL CHECK (length(prompt_message)>0),
 displayed_snapshot jsonb NOT NULL CHECK (jsonb_typeof(displayed_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,inbound_message),
 FOREIGN KEY(account_id,run_id) REFERENCES public.flow_runs(account_id,id)
);
ALTER TABLE public.flow_checkout_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flow_checkout_confirmations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.flow_checkout_confirmations TO service_role;
CREATE OR REPLACE FUNCTION public.flow_checkout_confirmation_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Consumed consent evidence is immutable' USING ERRCODE='23514'; END $$;
DROP TRIGGER IF EXISTS flow_checkout_confirmation_frozen ON public.flow_checkout_confirmations;
CREATE TRIGGER flow_checkout_confirmation_frozen BEFORE UPDATE OR DELETE ON public.flow_checkout_confirmations FOR EACH ROW EXECUTE FUNCTION public.flow_checkout_confirmation_freeze();
CREATE TABLE IF NOT EXISTS public.flow_checkout_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES public.accounts(id),
 run_id uuid NOT NULL,
 revision bigint NOT NULL,
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
 confirmation_message text NOT NULL CHECK (length(confirmation_message)>0),
 state text NOT NULL DEFAULT 'started' CHECK (state IN ('started','completed','reconciliation_required')),
 evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence)='object'),
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(account_id,run_id),
 FOREIGN KEY(account_id,run_id) REFERENCES public.flow_runs(account_id,id)
);
ALTER TABLE public.flow_checkout_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flow_checkout_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.flow_checkout_claims TO service_role;

CREATE OR REPLACE FUNCTION public.flow_checkout_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Checkout claims cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.account_id,NEW.run_id,NEW.revision,NEW.snapshot,NEW.confirmation_message,NEW.started_at)
 IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.run_id,OLD.revision,OLD.snapshot,OLD.confirmation_message,OLD.started_at)
 OR (OLD.finished_at IS NOT NULL AND (NEW.evidence,NEW.finished_at) IS DISTINCT FROM (OLD.evidence,OLD.finished_at))
 OR (OLD.state <> 'started' AND NEW.state='started') THEN
  RAISE EXCEPTION 'Checkout claim input/evidence is frozen' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS flow_checkout_frozen ON public.flow_checkout_claims;
CREATE TRIGGER flow_checkout_frozen BEFORE UPDATE OR DELETE ON public.flow_checkout_claims FOR EACH ROW EXECUTE FUNCTION public.flow_checkout_freeze();

-- Also invalidate direct legacy/admin mutations. No worker may silently cancel a started effect.
CREATE OR REPLACE FUNCTION public.flow_checkout_run_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.vars,NEW.status,NEW.current_node_key) IS DISTINCT FROM (OLD.vars,OLD.status,OLD.current_node_key) THEN
  NEW.consent_revision := greatest(NEW.consent_revision,OLD.consent_revision+1);
  IF NEW.status <> 'active' OR NEW.consent_confirmed_snapshot IS DISTINCT FROM NEW.vars THEN
   NEW.consent_confirmed_snapshot := NULL;
   NEW.consent_inbound_message := NULL;
   IF NEW.vars IS DISTINCT FROM OLD.vars THEN
    NEW.consent_prompt_snapshot := NULL;
    NEW.consent_prompt_node := NULL;
    NEW.consent_prompt_message := NULL;
   END IF;
  END IF;
  IF NEW.status <> 'active' OR NEW.vars IS DISTINCT FROM OLD.vars THEN
   UPDATE public.flow_checkout_claims SET state='reconciliation_required'
   WHERE account_id=OLD.account_id AND run_id=OLD.id AND finished_at IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS flow_checkout_run_guard ON public.flow_runs;
CREATE TRIGGER flow_checkout_run_guard BEFORE UPDATE ON public.flow_runs FOR EACH ROW EXECUTE FUNCTION public.flow_checkout_run_guard();

CREATE OR REPLACE FUNCTION public.flow_checkout_write(p_account_id uuid,p_run_id uuid,p_revision bigint,p_snapshot jsonb,p_vars jsonb)
RETURNS SETOF public.flow_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.status <> 'active' OR r.consent_revision <> p_revision OR r.vars IS DISTINCT FROM p_snapshot OR jsonb_typeof(p_vars) <> 'object' THEN RETURN; END IF;
 -- Never mutate the run while its insert-only checkout is in flight.
 IF EXISTS(SELECT 1 FROM public.flow_checkout_claims WHERE account_id=p_account_id AND run_id=p_run_id) THEN RETURN; END IF;
 IF r.vars IS NOT DISTINCT FROM p_vars THEN RETURN NEXT r; RETURN; END IF;
 UPDATE public.flow_runs SET vars=p_vars,consent_revision=consent_revision+1,consent_confirmed_snapshot=NULL,consent_inbound_message=NULL
 WHERE id=r.id RETURNING * INTO r;
 RETURN NEXT r;
END $$;

-- Internal only: no stale worker may queue a conversation owned by a newer run.
CREATE OR REPLACE FUNCTION public.flow_checkout_queue(p_account_id uuid,p_run_id uuid,p_conversation_id uuid,p_assign uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.conversations SET status='pending',updated_at=now(),assigned_agent_id=coalesce(p_assign,assigned_agent_id)
 WHERE account_id=p_account_id AND id=p_conversation_id
 AND NOT EXISTS(SELECT 1 FROM public.flow_runs WHERE account_id=p_account_id AND conversation_id=p_conversation_id AND id<>p_run_id AND status='active');
END $$;

CREATE OR REPLACE FUNCTION public.flow_checkout_transition(p_account_id uuid,p_run_id uuid,p_revision bigint,p_snapshot jsonb,p_node text,p_patch jsonb,p_prompt_message text DEFAULT NULL)
RETURNS SETOF public.flow_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs; next_node text; is_prompt boolean;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.status <> 'active' OR r.consent_revision <> p_revision OR r.vars IS DISTINCT FROM p_snapshot OR r.current_node_key IS DISTINCT FROM p_node THEN RETURN; END IF;
 IF jsonb_typeof(p_patch) <> 'object' OR p_patch - ARRAY['status','current_node_key','last_prompt_message_id','reprompt_count','end_reason','assigned_agent_id'] <> '{}'::jsonb THEN RAISE EXCEPTION 'Unsupported transition fields'; END IF;
 next_node := CASE WHEN p_patch ? 'current_node_key' THEN p_patch->>'current_node_key' ELSE r.current_node_key END;
 is_prompt := coalesce(length(p_prompt_message)>0,false) AND EXISTS(
  SELECT 1 FROM public.flow_nodes WHERE flow_id=r.flow_id AND node_key=next_node AND node_type='send_buttons'
  AND config->'buttons' @> '[{"reply_id":"confirmar_pedido"}]'
  AND position('{{vars.itens_lista}}' in config->>'text')>0
  AND position('{{vars.total_formatado}}' in config->>'text')>0
  AND position('{{vars.observacoes}}' in config->>'text')>0
  AND (r.vars->>'tipo_entrega'='retirada' OR position('{{vars.endereco}}' in config->>'text')>0));
 UPDATE public.flow_runs SET
  status=coalesce(p_patch->>'status',status), current_node_key=next_node,
  last_prompt_message_id=CASE WHEN p_patch ? 'last_prompt_message_id' THEN (p_patch->>'last_prompt_message_id')::uuid ELSE last_prompt_message_id END,
  reprompt_count=coalesce((p_patch->>'reprompt_count')::integer,reprompt_count),
  end_reason=coalesce(p_patch->>'end_reason',end_reason),
  ended_at=CASE WHEN coalesce(p_patch->>'status','active') <> 'active' THEN now() ELSE ended_at END,
  last_advanced_at=now(), consent_revision=consent_revision+1,
  consent_prompt_snapshot=CASE WHEN is_prompt THEN vars ELSE consent_prompt_snapshot END,
  consent_prompt_node=CASE WHEN is_prompt THEN next_node ELSE consent_prompt_node END,
  consent_prompt_message=CASE WHEN is_prompt THEN p_prompt_message ELSE consent_prompt_message END,
  consent_confirmed_snapshot=CASE WHEN is_prompt THEN NULL ELSE consent_confirmed_snapshot END,
  consent_inbound_message=CASE WHEN is_prompt THEN NULL ELSE consent_inbound_message END
 WHERE id=r.id RETURNING * INTO r;
 IF r.status='handed_off' THEN PERFORM public.flow_checkout_queue(p_account_id,p_run_id,r.conversation_id,(p_patch->>'assigned_agent_id')::uuid); END IF;
 RETURN NEXT r;
END $$;

-- Remove the old overload: no caller may bypass prompt binding via seven args.
DROP FUNCTION IF EXISTS public.flow_checkout_confirm(uuid,uuid,bigint,jsonb,text,text,text);
CREATE OR REPLACE FUNCTION public.flow_checkout_confirm(p_account_id uuid,p_run_id uuid,p_revision bigint,p_snapshot jsonb,p_inbound_message text,p_kind text,p_reply text,p_context_message text DEFAULT NULL)
RETURNS SETOF public.flow_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.status <> 'active' OR r.consent_revision <> p_revision OR r.vars IS DISTINCT FROM p_snapshot
 OR r.consent_prompt_snapshot IS DISTINCT FROM r.vars OR r.consent_prompt_node IS DISTINCT FROM r.current_node_key
 OR coalesce(r.consent_prompt_message,'')='' OR coalesce(p_inbound_message,'')='' OR r.consent_inbound_message IS NOT NULL THEN RETURN; END IF;
 IF NOT coalesce(((p_kind='interactive_reply' AND p_reply='confirmar_pedido'
 AND coalesce(p_context_message,'')<>'' AND p_context_message=r.consent_prompt_message)
 OR (p_kind='text' AND lower(btrim(p_reply)) IN ('confirmar','confirmar pedido','sim','confirmo'))),false) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.flow_nodes WHERE flow_id=r.flow_id AND node_key=r.current_node_key AND node_type='send_buttons' AND config->'buttons' @> '[{"reply_id":"confirmar_pedido"}]') THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.flow_checkout_claims WHERE account_id=p_account_id AND run_id=p_run_id) THEN RETURN; END IF;
 INSERT INTO public.flow_checkout_confirmations(account_id,run_id,inbound_message,prompt_message,displayed_snapshot)
 VALUES(p_account_id,p_run_id,p_inbound_message,r.consent_prompt_message,r.vars)
 ON CONFLICT(account_id,inbound_message) DO NOTHING;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE public.flow_runs SET vars=vars || '{"pedido_confirmado":"true"}',
 consent_confirmed_snapshot=vars || '{"pedido_confirmado":"true"}',consent_inbound_message=p_inbound_message,consent_revision=consent_revision+1
 WHERE id=r.id RETURNING * INTO r;
 RETURN NEXT r;
END $$;

CREATE OR REPLACE FUNCTION public.flow_checkout_authorize(p_account_id uuid,p_run_id uuid,p_revision bigint,p_snapshot jsonb)
RETURNS TABLE(claim_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.status <> 'active' OR r.consent_revision <> p_revision OR r.vars IS DISTINCT FROM p_snapshot
 OR r.consent_confirmed_snapshot IS DISTINCT FROM r.vars OR coalesce(r.consent_inbound_message,'')=''
 OR r.vars->>'pedido_confirmado' <> 'true' OR r.vars->>'catalog_order_version' <> '1'
 OR jsonb_typeof(r.vars->'itens') IS DISTINCT FROM 'array' THEN RETURN; END IF;
 IF jsonb_array_length(r.vars->'itens')=0 THEN RETURN; END IF;
 RETURN QUERY INSERT INTO public.flow_checkout_claims(account_id,run_id,revision,snapshot,confirmation_message)
 VALUES(p_account_id,p_run_id,p_revision,p_snapshot,r.consent_inbound_message)
 ON CONFLICT(account_id,run_id) DO NOTHING RETURNING id;
END $$;

CREATE OR REPLACE FUNCTION public.flow_checkout_correct(p_account_id uuid,p_run_id uuid,p_text text)
RETURNS SETOF public.flow_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND OR coalesce(length(p_text),0)=0 THEN RETURN; END IF;
 UPDATE public.flow_runs SET vars=vars || jsonb_build_object('pedido_confirmado','false','catalog_review_text',p_text,'pending_order_change',p_text),
 status='handed_off',ended_at=now(),end_reason='order_change_requires_review',consent_revision=consent_revision+1,
 consent_confirmed_snapshot=NULL,consent_inbound_message=NULL WHERE id=r.id RETURNING * INTO r;
 UPDATE public.flow_checkout_claims SET state='reconciliation_required' WHERE account_id=p_account_id AND run_id=p_run_id;
 PERFORM public.flow_checkout_queue(p_account_id,p_run_id,r.conversation_id);
 RETURN NEXT r;
END $$;

CREATE OR REPLACE FUNCTION public.flow_checkout_finish(p_account_id uuid,p_run_id uuid,p_claim_id uuid,p_evidence jsonb,p_success boolean)
RETURNS TABLE(owned boolean,vars jsonb,consent_revision bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.flow_runs; c public.flow_checkout_claims; owns boolean;
BEGIN
 SELECT * INTO r FROM public.flow_runs WHERE account_id=p_account_id AND id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO c FROM public.flow_checkout_claims WHERE account_id=p_account_id AND run_id=p_run_id AND id=p_claim_id FOR UPDATE;
 IF NOT FOUND OR c.finished_at IS NOT NULL THEN RETURN; END IF;
 IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Evidence must be an object'; END IF;
 owns := r.status='active' AND r.consent_revision=c.revision AND r.vars=c.snapshot AND c.state='started';
 UPDATE public.flow_checkout_claims SET evidence=p_evidence,finished_at=now(),state=CASE WHEN owns AND p_success THEN 'completed' ELSE 'reconciliation_required' END WHERE id=c.id;
 IF owns AND p_success THEN
  -- Evidence never has authority to replace customer input/consent.
  UPDATE public.flow_runs SET vars=r.vars || (SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(p_evidence) WHERE key IN ('order_id','deal_id','link_mercado_pago','external_reference')),consent_revision=r.consent_revision+1 WHERE id=r.id RETURNING * INTO r;
 ELSIF owns THEN
  UPDATE public.flow_runs SET status='handed_off',ended_at=now(),end_reason='checkout_requires_reconciliation',consent_revision=r.consent_revision+1 WHERE id=r.id RETURNING * INTO r;
  PERFORM public.flow_checkout_queue(p_account_id,p_run_id,r.conversation_id);
 END IF;
 RETURN QUERY SELECT owns,r.vars,r.consent_revision;
END $$;

-- PostgreSQL grants PUBLIC execute by default; Supabase may additionally grant
-- anon/authenticated via default privileges. Enumerate only this protocol.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
 ('flow_checkout_confirmation_freeze','flow_checkout_freeze','flow_checkout_run_guard','flow_checkout_queue','flow_checkout_write','flow_checkout_transition','flow_checkout_confirm','flow_checkout_authorize','flow_checkout_correct','flow_checkout_finish') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f);
  IF f::text NOT LIKE '%flow_checkout_confirmation_freeze(%' AND f::text NOT LIKE '%flow_checkout_freeze(%' AND f::text NOT LIKE '%flow_checkout_run_guard(%' AND f::text NOT LIKE '%flow_checkout_queue(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END IF;
 END LOOP;
END $$;
COMMIT;
