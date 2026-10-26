INSERT INTO permissions (key, name_ar, sort_order) VALUES
  ('records.delete', 'حذف السجلات نهائيًا', 990)
ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar, sort_order = EXCLUDED.sort_order;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS users_deleted_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;
