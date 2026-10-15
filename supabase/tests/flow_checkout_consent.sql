-- Isolated fixture only, after 038. No external effects. Transaction rolls back.
BEGIN;
DO $$
DECLARE a uuid := '00000000-0000-0000-0000-000000000001';
 b uuid := '00000000-0000-0000-0000-000000000002'; r public.flow_runs; c uuid; f oid; confirmation_text text;
 v jsonb := '{"catalog_order_version":1,"itens":[{"id":"sku","title":"Carne","description":"Carne","quantity":2,"unitPrice":14.5}],"total":29,"tipo_entrega":"delivery","endereco":"Rua Um, 123 Centro"}';
BEGIN
 -- A fresh click without the original Meta prompt context must fail closed.
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','confirmar_delivery',v) RETURNING * INTO r;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','summary-A');
 SELECT * INTO r FROM flow_checkout_write(a,r.id,r.consent_revision,r.vars,r.vars || '{"endereco":"Rua B, 456 Centro"}');
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{}','summary-B');
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'missing-context','interactive_reply','confirmar_pedido')) THEN RAISE EXCEPTION 'contextless old button authorized snapshot B'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'old-click-A','interactive_reply','confirmar_pedido','summary-A')) THEN RAISE EXCEPTION 'button A authorized snapshot B'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'empty-context','interactive_reply','confirmar_pedido','')) THEN RAISE EXCEPTION 'empty context authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'null-reply','interactive_reply',NULL,'summary-B')) THEN RAISE EXCEPTION 'null reply authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars)) THEN RAISE EXCEPTION 'rejected click authorized checkout'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirmations WHERE run_id=r.id) THEN RAISE EXCEPTION 'rejected click consumed evidence'; END IF;
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'fresh-click-B','interactive_reply','confirmar_pedido','summary-B');
 IF r.id IS NULL THEN RAISE EXCEPTION 'current button B rejected'; END IF;
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_confirmations WHERE run_id=r.id AND inbound_message='fresh-click-B' AND prompt_message='summary-B' AND displayed_snapshot->>'endereco'='Rua B, 456 Centro') THEN RAISE EXCEPTION 'button evidence does not bind snapshot B'; END IF;
 SELECT claim_id INTO c FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars);
 IF c IS NULL THEN RAISE EXCEPTION 'current button B cannot authorize'; END IF;
 IF to_regprocedure('public.flow_checkout_confirm(uuid,uuid,bigint,jsonb,text,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'legacy unbound overload remains'; END IF;
 -- Text is an intentional context-free channel, retaining its exact allowlist.
 FOREACH confirmation_text IN ARRAY ARRAY['confirmar','confirmar pedido','sim','confirmo'] LOOP
  INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
  SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','text-summary-' || confirmation_text);
  SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'text-inbound-' || confirmation_text,'text',confirmation_text);
  IF r.id IS NULL THEN RAISE EXCEPTION 'supported text confirmation rejected: %',confirmation_text; END IF;
 END LOOP;
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','confirmar_delivery',v) RETURNING * INTO r;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,0,v)) THEN RAISE EXCEPTION 'arbitrary vars authorized'; END IF;
 SELECT * INTO r FROM flow_checkout_write(a,r.id,0,v,v || '{"pedido_confirmado":"true"}');
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars)) THEN RAISE EXCEPTION 'boolean authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'inbound','text','confirmar')) THEN RAISE EXCEPTION 'undisplayed summary confirmed'; END IF;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{"current_node_key":"confirmar_delivery"}', 'outbound-summary');
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'negative','text','nao confirmar')) THEN RAISE EXCEPTION 'negative confirmed'; END IF;
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'inbound','text','confirmar');
 IF r.id IS NULL THEN RAISE EXCEPTION 'genuine confirmation rejected'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(b,r.id,r.consent_revision,r.vars)) THEN RAISE EXCEPTION 'cross account authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision-1,r.vars)) THEN RAISE EXCEPTION 'stale revision authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars || '{"total":30}')) THEN RAISE EXCEPTION 'different snapshot authorized'; END IF;
 SELECT claim_id INTO c FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars);
 IF c IS NULL THEN RAISE EXCEPTION 'confirmed snapshot not authorized'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars)) THEN RAISE EXCEPTION 'duplicate authorization'; END IF;
 BEGIN
  UPDATE flow_checkout_claims SET snapshot = '{}' WHERE id=c;
  RAISE EXCEPTION 'claim input mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  DELETE FROM flow_checkout_claims WHERE id=c;
  RAISE EXCEPTION 'claim deletable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 SELECT * INTO r FROM flow_checkout_correct(a,r.id,'troca para 1 carne');
 IF EXISTS(SELECT 1 FROM flow_checkout_write(a,r.id,r.consent_revision-1,v,v)) THEN RAISE EXCEPTION 'stale worker wrote correction'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(b,r.id,c,'{}',true)) THEN RAISE EXCEPTION 'cross account finish'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{"order_id":"order","deal_id":"deal"}',true) WHERE owned) THEN RAISE EXCEPTION 'corrected finish owned'; END IF;
 IF (SELECT vars FROM flow_runs WHERE id=r.id) <> r.vars THEN RAISE EXCEPTION 'finish overwrote correction'; END IF;
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_claims WHERE id=c AND state='reconciliation_required' AND evidence->>'order_id'='order') THEN RAISE EXCEPTION 'evidence lost'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{"order_id":"overwrite"}',true)) THEN RAISE EXCEPTION 'finish repeat accepted'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{"status":"completed"}',NULL)) THEN RAISE EXCEPTION 'inactive transition accepted'; END IF;
 -- Correction before authorization: no durable claim and no possible external effect.
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
 PERFORM flow_checkout_correct(a,r.id,'cancelar');
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,0,v)) THEN RAISE EXCEPTION 'preauth correction ignored'; END IF;
 -- An owned finish is one-shot and returns the next CAS revision.
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','summary-success');
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'success-inbound','text','confirmar');
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{"current_node_key":"set_confirmado_delivery"}');
 SELECT * INTO r FROM flow_checkout_write(a,r.id,r.consent_revision,r.vars,r.vars);
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{"current_node_key":"gerar_pagamento"}');
 SELECT claim_id INTO c FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars);
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{"order_id":"canonical","deal_id":"deal","total":999}',true) WHERE owned AND consent_revision=r.consent_revision+1 AND vars->>'total'='29') THEN RAISE EXCEPTION 'owned finish failed/changed customer input'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{}',true)) THEN RAISE EXCEPTION 'successful finish replayed'; END IF;
 BEGIN
  UPDATE flow_checkout_claims SET state='started' WHERE id=c;
  RAISE EXCEPTION 'terminal claim restarted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- The latest displayed summary requires a fresh confirmation, even if an
 -- arbitrary boolean is retained, and vars writes invalidate prompt evidence.
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','summary-one');
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'first-confirm','text','confirmar');
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,r.current_node_key,'{}','summary-two');
 IF EXISTS(SELECT 1 FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars)) THEN RAISE EXCEPTION 'old confirmation authorized newer summary'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'first-confirm','text','confirmar')) THEN RAISE EXCEPTION 'consumed inbound confirmed a later summary'; END IF;
 SELECT * INTO r FROM flow_checkout_write(a,r.id,r.consent_revision,r.vars,r.vars || '{"total":30}');
 IF EXISTS(SELECT 1 FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'stale-summary-confirm','text','confirmar')) THEN RAISE EXCEPTION 'changed vars reused old summary'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_transition(a,r.id,r.consent_revision,r.vars,'other-node','{"status":"completed"}')) THEN RAISE EXCEPTION 'wrong node transition accepted'; END IF;
 -- Legacy/admin direct mutations also invalidate the same run revision and
 -- retain a started claim for reconciliation (never silently cancel it).
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','legacy-summary');
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'legacy-confirm','text','confirmar');
 SELECT claim_id INTO c FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars);
 UPDATE flow_runs SET status='paused_by_agent', vars=vars || '{"observacoes":"correction"}' WHERE id=r.id;
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_claims WHERE id=c AND state='reconciliation_required') THEN RAISE EXCEPTION 'direct correction silently canceled started claim'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{"order_id":"legacy-evidence"}',true) WHERE owned) THEN RAISE EXCEPTION 'legacy mutation retained finish ownership'; END IF;
 -- An owned failed/uncertain checkout is finalized once for reconciliation,
 -- never published as successful vars or released for an automatic retry.
 INSERT INTO flow_runs(account_id,flow_id,user_id,current_node_key,vars) VALUES(a,r.flow_id,r.user_id,'confirmar_delivery',v) RETURNING * INTO r;
 SELECT * INTO r FROM flow_checkout_transition(a,r.id,0,v,r.current_node_key,'{}','failure-summary');
 SELECT * INTO r FROM flow_checkout_confirm(a,r.id,r.consent_revision,r.vars,'failure-confirm','text','confirmar');
 SELECT claim_id INTO c FROM flow_checkout_authorize(a,r.id,r.consent_revision,r.vars);
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{"order_id":"partial","error":"timeout"}',false) WHERE owned) THEN RAISE EXCEPTION 'owned failure evidence rejected'; END IF;
 IF NOT EXISTS(SELECT 1 FROM flow_runs WHERE id=r.id AND status='handed_off' AND NOT vars ? 'order_id') THEN RAISE EXCEPTION 'owned failure published success'; END IF;
 IF NOT EXISTS(SELECT 1 FROM flow_checkout_claims WHERE id=c AND state='reconciliation_required' AND evidence->>'order_id'='partial' AND finished_at IS NOT NULL) THEN RAISE EXCEPTION 'owned failure released durable claim'; END IF;
 IF EXISTS(SELECT 1 FROM flow_checkout_finish(a,r.id,c,'{}',true)) THEN RAISE EXCEPTION 'owned failure retried'; END IF;
 -- Service-only RPCs and select-only frozen claims, even with Supabase default grants.
 FOR f IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'flow_checkout_%' LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'client RPC grant'; END IF;
 END LOOP;
 IF has_table_privilege('service_role','flow_checkout_claims','INSERT,UPDATE,DELETE') OR has_table_privilege('anon','flow_checkout_claims','SELECT') OR has_table_privilege('authenticated','flow_checkout_claims','SELECT') THEN RAISE EXCEPTION 'unsafe ledger grants'; END IF;
 IF NOT has_table_privilege('service_role','flow_checkout_claims','SELECT') THEN RAISE EXCEPTION 'missing reconciliation grant'; END IF;
 IF has_table_privilege('service_role','flow_checkout_confirmations','INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated','flow_checkout_confirmations','SELECT') THEN RAISE EXCEPTION 'unsafe consent history grants'; END IF;
 BEGIN
  UPDATE flow_checkout_confirmations SET displayed_snapshot='{}' WHERE inbound_message='first-confirm';
  RAISE EXCEPTION 'consumed evidence overwritten';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='flow_checkout_claims'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'missing RLS'; END IF;
 RAISE NOTICE 'PASS: consent sequential protocol and privilege assertions';
END $$;
ROLLBACK;
