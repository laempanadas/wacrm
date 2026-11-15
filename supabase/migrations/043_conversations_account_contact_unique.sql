-- One conversation per (account, contact).
--
-- The inbound webhook looks up a conversation by (account_id, contact_id) and
-- creates one when missing. Without a unique index, two concurrent deliveries
-- from the same customer (e.g. a catalog cart followed by flavour text) can each
-- create a conversation. Order drafts, flow runs and the AI counter are scoped
-- by conversation, so the customer's state splits across rows.
--
-- This migration does NOT merge existing duplicates: merging moves messages,
-- order_drafts and flow_runs and needs a human decision. It fails loudly instead.
-- Diagnose first with:
--   SELECT account_id, contact_id, count(*), array_agg(id ORDER BY created_at)
--   FROM public.conversations GROUP BY account_id, contact_id HAVING count(*) > 1;

DO $$
DECLARE
  duplicate_pairs integer;
BEGIN
  SELECT count(*) INTO duplicate_pairs
  FROM (
    SELECT account_id, contact_id
    FROM public.conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  ) AS duplicates;

  IF duplicate_pairs > 0 THEN
    RAISE EXCEPTION
      'conversations has % duplicated (account_id, contact_id) pairs; reconcile them before applying migration 043',
      duplicate_pairs;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_unique
  ON public.conversations (account_id, contact_id);
