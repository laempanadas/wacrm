-- Idempotent inbound history independently of whatsapp_inbound_receipts.
-- Deliberately fail if historic duplicates exist; reconcile them explicitly
-- (including reply/reaction references) instead of silently deleting history.
CREATE UNIQUE INDEX IF NOT EXISTS messages_customer_meta_id_unique
  ON public.messages (conversation_id, message_id)
  WHERE sender_type = 'customer' AND message_id IS NOT NULL;

-- Used by the server-side 24-hour customer session gate.
CREATE INDEX IF NOT EXISTS messages_latest_customer_inbound
  ON public.messages (conversation_id, created_at DESC)
  WHERE sender_type = 'customer';
