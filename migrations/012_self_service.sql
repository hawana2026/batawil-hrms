ALTER TABLE users ADD COLUMN employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX users_employee_uq ON users (employee_id) WHERE employee_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_employee_idx ON users (employee_id);
