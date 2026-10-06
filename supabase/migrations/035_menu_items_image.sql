-- ============================================================
-- 035_menu_items_image.sql — Add image_url to menu_items
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'menu_items') THEN
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url text;
  END IF;
END $$;
