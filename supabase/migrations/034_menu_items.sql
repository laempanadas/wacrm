-- ============================================================
-- 034_menu_items.sql — Menu items and availability
--
-- Adds the `menu_items` table backing the CRM menu management
-- and the public `/api/v1/menu` endpoint. Supports toggling
-- availability (pausing out-of-stock items) in real time.
-- ============================================================

CREATE TABLE IF NOT EXISTS menu_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  price        numeric(10,2) NOT NULL DEFAULT 0,
  category     text NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  description  text,
  emoji        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Ensure all requested columns exist if table was already created
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'menu_items') THEN
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name text;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price numeric(10,2) DEFAULT 0;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS category text;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available boolean DEFAULT true;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description text;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS emoji text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS menu_items_account_id_idx ON menu_items (account_id);
CREATE INDEX IF NOT EXISTS menu_items_category_idx ON menu_items (account_id, category);

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS menu_items_select ON menu_items;
CREATE POLICY menu_items_select ON menu_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS menu_items_insert ON menu_items;
CREATE POLICY menu_items_insert ON menu_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS menu_items_update ON menu_items;
CREATE POLICY menu_items_update ON menu_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS menu_items_delete ON menu_items;
CREATE POLICY menu_items_delete ON menu_items FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.update_menu_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS menu_items_updated_at ON menu_items;
CREATE TRIGGER menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_menu_items_updated_at();
