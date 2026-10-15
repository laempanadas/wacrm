-- Run against an isolated PostgreSQL fixture after migration 036 (never production).
BEGIN;
DO $$
DECLARE result jsonb; row_count integer;
BEGIN
  result := claim_order_turn('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'wamid-sql-1', '2 carne sem pimentão');
  IF result->>'outcome' <> 'claimed' THEN RAISE EXCEPTION 'First turn not claimed'; END IF;
  result := claim_order_turn('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'wamid-sql-1', '2 carne sem pimentão');
  IF result->>'outcome' <> 'duplicate' THEN RAISE EXCEPTION 'Retry not deduplicated'; END IF;
  result := claim_order_turn('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'wamid-sql-2', 'mais 1 calabresa');
  IF result->>'outcome' <> 'busy' THEN RAISE EXCEPTION 'Concurrent turn not blocked'; END IF;
  SELECT count(*) INTO row_count FROM order_drafts;
  IF row_count <> 1 THEN RAISE EXCEPTION 'Duplicate draft'; END IF;
  IF (SELECT raw_text FROM order_inbound_events WHERE meta_message_id = 'wamid-sql-2') <> 'mais 1 calabresa' THEN RAISE EXCEPTION 'Blocked input lost'; END IF;
  UPDATE order_drafts SET processing_message_id = NULL;
  result := claim_order_turn('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'wamid-sql-3', 'confirmo o pedido');
  IF result->>'outcome' <> 'claimed' THEN RAISE EXCEPTION 'Next turn not claimed after release'; END IF;
  IF has_function_privilege('authenticated', 'claim_order_turn(uuid,uuid,uuid,text,text)', 'EXECUTE') THEN RAISE EXCEPTION 'Internal RPC exposed'; END IF;
  IF has_table_privilege('authenticated', 'order_drafts', 'UPDATE') THEN RAISE EXCEPTION 'Internal draft exposed'; END IF;
  BEGIN
    PERFORM claim_order_turn('99999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'cross-tenant', '1 carne');
    RAISE EXCEPTION 'Cross-account turn accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'Cross-account turn accepted' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
