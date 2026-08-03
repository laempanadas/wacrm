-- ============================================================
-- Flows: allow the 'catalog_order' trigger type.
--
-- Why: La Empanadas takes orders through the Meta WhatsApp catalog.
-- When a customer sends their cart, Meta delivers an `order` webhook
-- message. The "Pedido de empanadas" flow must start from that event
-- (collect delivery type, address and payment), so `flows.trigger_type`
-- needs a new allowed value: 'catalog_order'.
--
-- Migration 010 defined the CHECK as
--   trigger_type IN ('keyword', 'first_inbound_message', 'manual')
-- which would reject any insert/update using 'catalog_order'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Widen the CHECK constraint on flows.trigger_type.
ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'catalog_order', 'manual'));

-- Migrate the existing "Pedido de empanadas" flow (if it was created
-- from the earlier template that used 'first_inbound_message') to the
-- new catalog trigger, so it fires from a catalog order instead of the
-- contact's first message.
UPDATE flows
  SET trigger_type = 'catalog_order',
      trigger_config = '{}'::jsonb
  WHERE name = 'Pedido de empanadas'
    AND trigger_type = 'first_inbound_message';
