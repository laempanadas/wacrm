-- ============================================================================
-- MANUAL SCRIPT — NOT A MIGRATION. Do not place in supabase/migrations/.
--
-- Merges duplicate public.conversations rows that share (account_id, contact_id)
-- into the OLDEST row of each pair, then deletes the duplicates. Run this BEFORE
-- migration 043 (which creates the unique index and refuses to run while
-- duplicates exist).
--
-- Safety properties:
--   * One DO block = one transaction. Any error rolls everything back.
--   * `apply` defaults to false: the run is a dry run and always rolls back.
--     Set it to true only after reviewing the NOTICE output of a dry run.
--   * It refuses (RAISE EXCEPTION) rather than guessing when:
--       - both conversations of a pair hold an order draft (carts can't be merged blindly);
--       - a draft is claimed (processing_message_id set) or an outbox effect is
--         'sending'/'uncertain' (reconciliation must happen first);
--       - both conversations have an 'active' flow run;
--       - both conversations hold a customer message with the same Meta message_id.
--   * Every table/column named conversation_id or payment_conversation_id in
--     public is repointed, so new tables are covered without editing this file.
--     A final check aborts if any reference to a duplicate id remains.
--   * Conversation state is merged conservatively: a human/AI pause on ANY row
--     keeps the pause; unread counts add up; last_message_at takes the latest.
--
-- Before running, read the diagnostic (also in docs/diagnostico-pedidos-whatsapp.md):
--   SELECT account_id, contact_id, count(*), array_agg(id ORDER BY created_at)
--   FROM public.conversations GROUP BY account_id, contact_id HAVING count(*) > 1;
-- ============================================================================

DO $merge$
DECLARE
  apply boolean := false;   -- DRY RUN by default. Change to true to keep changes.
  pairs integer;
  conflicts integer;
  ref record;
  leftover integer;
BEGIN
  CREATE TEMP TABLE conv_merge_map (
    dup_id uuid PRIMARY KEY,
    keep_id uuid NOT NULL,
    account_id uuid NOT NULL,
    contact_id uuid NOT NULL
  ) ON COMMIT DROP;

  -- Keeper = oldest row per (account, contact); id breaks ties deterministically.
  INSERT INTO conv_merge_map (dup_id, keep_id, account_id, contact_id)
  SELECT c.id, k.keep_id, c.account_id, c.contact_id
  FROM public.conversations c
  JOIN LATERAL (
    SELECT k2.id AS keep_id
    FROM public.conversations k2
    WHERE k2.account_id = c.account_id AND k2.contact_id = c.contact_id
    ORDER BY k2.created_at, k2.id
    LIMIT 1
  ) k ON true
  WHERE c.id <> k.keep_id;

  SELECT count(*) INTO pairs FROM conv_merge_map;
  RAISE NOTICE 'duplicate conversations to merge: %', pairs;
  IF pairs = 0 THEN
    RAISE NOTICE 'nothing to merge; migration 043 can be applied.';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------- preflight
  SELECT count(*) INTO conflicts
  FROM conv_merge_map m
  JOIN public.order_drafts dd ON dd.conversation_id = m.dup_id
  JOIN public.order_drafts kd ON kd.conversation_id = m.keep_id;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % pair(s) have an order draft on both conversations; decide the cart manually', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM (
    SELECT m.keep_id
    FROM conv_merge_map m
    JOIN public.order_drafts d ON d.conversation_id = m.dup_id
    GROUP BY m.keep_id
    HAVING count(*) > 1
  ) multi;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % keeper(s) would receive more than one order draft', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM public.order_drafts d
  JOIN conv_merge_map m ON d.conversation_id IN (m.dup_id, m.keep_id)
  WHERE d.processing_message_id IS NOT NULL;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % order draft(s) are claimed by an in-flight turn; wait or reconcile', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM public.order_message_outbox o
  JOIN conv_merge_map m ON o.conversation_id IN (m.dup_id, m.keep_id)
  WHERE o.status IN ('sending', 'uncertain');
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % outbound effect(s) in doubt (sending/uncertain); reconcile first', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM conv_merge_map m
  JOIN public.flow_runs dr ON dr.conversation_id = m.dup_id AND dr.status = 'active'
  JOIN public.flow_runs kr ON kr.conversation_id = m.keep_id AND kr.status = 'active';
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % pair(s) have an active flow run on both conversations', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM conv_merge_map m
  JOIN public.messages a ON a.conversation_id = m.dup_id
                        AND a.sender_type = 'customer' AND a.message_id IS NOT NULL
  JOIN public.messages b ON b.conversation_id = m.keep_id
                        AND b.sender_type = 'customer' AND b.message_id = a.message_id;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % customer message(s) exist in both conversations with the same Meta id; reconcile history first', conflicts;
  END IF;

  RAISE NOTICE 'preflight passed';

  -- ------------------------------------------------------------------- repoint
  -- order_drafts: one per conversation (UNIQUE account_id, conversation_id).
  -- Preflight guarantees the keeper has none, so the move cannot collide.
  UPDATE public.order_drafts d
  SET conversation_id = m.keep_id
  FROM conv_merge_map m
  WHERE d.conversation_id = m.dup_id AND d.account_id = m.account_id;

  -- Every other table/column that references a conversation.
  FOR ref IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name IN ('conversation_id', 'payment_conversation_id')
      AND c.table_name NOT IN ('conversations', 'order_drafts')
  LOOP
    EXECUTE format(
      'UPDATE public.%I AS t SET %I = m.keep_id FROM conv_merge_map m WHERE t.%I = m.dup_id',
      ref.table_name, ref.column_name, ref.column_name
    );
    RAISE NOTICE 'repointed %.%', ref.table_name, ref.column_name;
  END LOOP;

  -- ------------------------------------------------------- keeper state merge
  UPDATE public.conversations k
  SET
    ai_autoreply_disabled = k.ai_autoreply_disabled OR EXISTS (
      SELECT 1 FROM public.conversations d
      JOIN conv_merge_map m ON m.dup_id = d.id
      WHERE m.keep_id = k.id AND d.ai_autoreply_disabled
    ),
    unread_count = COALESCE(k.unread_count, 0) + COALESCE((
      SELECT sum(d.unread_count) FROM public.conversations d
      JOIN conv_merge_map m ON m.dup_id = d.id
      WHERE m.keep_id = k.id
    ), 0),
    last_message_at = GREATEST(k.last_message_at, (
      SELECT max(d.last_message_at) FROM public.conversations d
      JOIN conv_merge_map m ON m.dup_id = d.id
      WHERE m.keep_id = k.id
    )),
    updated_at = now()
  WHERE k.id IN (SELECT keep_id FROM conv_merge_map);

  -- -------------------------------------------------------------- delete dups
  DELETE FROM public.conversations c
  USING conv_merge_map m
  WHERE c.id = m.dup_id;

  -- -------------------------------------------------------------- final checks
  SELECT count(*) INTO leftover
  FROM public.conversations c
  JOIN conv_merge_map m ON c.id = m.dup_id;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicate conversation row(s) still exist', leftover;
  END IF;

  leftover := 0;
  FOR ref IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name IN ('conversation_id', 'payment_conversation_id')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I t JOIN conv_merge_map m ON t.%I = m.dup_id',
      ref.table_name, ref.column_name
    ) INTO conflicts;
    leftover := leftover + conflicts;
  END LOOP;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'ABORT: % reference(s) to duplicate conversations remain', leftover;
  END IF;

  SELECT count(*) INTO conflicts FROM (
    SELECT account_id, contact_id FROM public.conversations
    GROUP BY account_id, contact_id HAVING count(*) > 1
  ) still;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicated (account_id, contact_id) pair(s) remain', conflicts;
  END IF;

  IF apply THEN
    RAISE NOTICE 'merged % duplicate conversation(s); committing.', pairs;
  ELSE
    RAISE EXCEPTION 'DRY RUN OK (% duplicate(s) would be merged). Nothing was kept. Set apply := true to commit.', pairs;
  END IF;
END
$merge$;
