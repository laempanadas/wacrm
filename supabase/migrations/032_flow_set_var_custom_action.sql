-- ============================================================
-- 032_flow_set_var_custom_action.sql
--
-- Flows: add 'set_var' and 'custom_action' node types.
--
-- Enables the La Empanadas ordering flow to:
--   1. set_var: persist button/list choices into flow_runs.vars
--   2. custom_action: trigger the pipeline deal creation
--
-- The node_type CHECK was created in migration 016 and widened
-- in 016 for send_media. We drop and re-add it with the two new
-- values, preserving all existing types.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',         -- From 016: preserved
    'collect_input',
    'condition',
    'set_tag',
    'set_var',            -- persist value into flow_runs.vars
    'custom_action',      -- create_order_deal / future actions
    'handoff',
    'http_fetch',
    'end'
  ));
