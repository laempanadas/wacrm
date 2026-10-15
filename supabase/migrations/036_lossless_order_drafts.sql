-- Structured order state and durable at-most-once claims.
-- New internal tables are service-role only. No existing RLS policies are changed.
CREATE TABLE IF NOT EXISTS public.order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}',
  processing_message_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS public.order_inbound_events (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  meta_message_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  raw_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'blocked', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, meta_message_id)
);
CREATE TABLE IF NOT EXISTS public.order_message_outbox (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  effect_key text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain')),
  message_id text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, effect_key)
);
CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_receipts (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  meta_message_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, meta_message_id)
);
ALTER TABLE public.order_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_inbound_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_inbound_receipts ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
REVOKE ALL ON public.order_drafts, public.order_inbound_events, public.order_message_outbox, public.whatsapp_inbound_receipts FROM anon, authenticated;
GRANT ALL ON public.order_drafts, public.order_inbound_events, public.order_message_outbox, public.whatsapp_inbound_receipts TO service_role;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS interactive_payload jsonb;

-- Serialize turns durably across workers. A crashed/ambiguous turn is not
-- automatically reclaimed: staff must reconcile it, rather than duplicate effects.
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
  UPDATE public.order_drafts SET processing_message_id = p_message_id, updated_at = now() WHERE id = draft.id;
  RETURN jsonb_build_object('outcome', 'claimed', 'id', draft.id, 'state', draft.state);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_order_turn(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_turn(uuid, uuid, uuid, text, text) TO service_role;
