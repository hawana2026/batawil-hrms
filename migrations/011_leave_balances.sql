CREATE TABLE leave_types (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  annual_entitlement numeric(6,2) NOT NULL DEFAULT 0 CHECK (annual_entitlement >= 0),
  paid boolean NOT NULL DEFAULT true,
  track_balance boolean NOT NULL DEFAULT true,
  requires_document boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leave_types_code_uq ON leave_types (lower(code));
CREATE UNIQUE INDEX leave_types_name_uq ON leave_types (lower(name));

INSERT INTO leave_types (id, code, name, annual_entitlement, paid, track_balance, requires_document, sort_order) VALUES
  (gen_random_uuid(), 'annual', 'إجازة سنوية', 30, true, true, false, 10),
  (gen_random_uuid(), 'sick', 'إجازة مرضية', 14, true, true, false, 20),
  (gen_random_uuid(), 'emergency', 'إجازة طارئة', 3, true, true, false, 30),
  (gen_random_uuid(), 'unpaid', 'إجازة بدون راتب', 0, false, false, false, 40),
  (gen_random_uuid(), 'permission', 'إذن', 0, true, false, false, 50),
  (gen_random_uuid(), 'other', 'أخرى', 0, true, false, false, 60);

ALTER TABLE leave_requests ADD COLUMN leave_type_id uuid REFERENCES leave_types(id) ON DELETE SET NULL;
UPDATE leave_requests l SET leave_type_id = t.id FROM leave_types t WHERE t.code = l.leave_type;
CREATE INDEX leave_requests_type_idx ON leave_requests (leave_type_id);

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_leave_type_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_check CHECK (leave_type ~ '^[a-z][a-z0-9_]{1,39}$');

CREATE TABLE leave_balances (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  entitlement numeric(6,2) NOT NULL DEFAULT 0 CHECK (entitlement >= 0),
  used numeric(6,2) NOT NULL DEFAULT 0 CHECK (used >= 0),
  adjusted numeric(6,2) NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type_id, year)
);
CREATE INDEX leave_balances_year_idx ON leave_balances (year, employee_id);

CREATE TABLE leave_balance_movements (
  id uuid PRIMARY KEY,
  balance_id uuid NOT NULL REFERENCES leave_balances(id) ON DELETE CASCADE,
  leave_request_id uuid REFERENCES leave_requests(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('usage', 'adjustment', 'restore', 'opening')),
  days numeric(6,2) NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leave_balance_movements_balance_idx ON leave_balance_movements (balance_id, created_at);
CREATE UNIQUE INDEX leave_balance_usage_uq
  ON leave_balance_movements (leave_request_id, kind)
  WHERE leave_request_id IS NOT NULL AND kind = 'usage';

INSERT INTO leave_balances (id, employee_id, leave_type_id, year, entitlement)
SELECT gen_random_uuid(), e.id, t.id, EXTRACT(YEAR FROM CURRENT_DATE)::int, t.annual_entitlement
FROM employees e
CROSS JOIN leave_types t
WHERE t.active = true AND t.track_balance = true AND t.annual_entitlement > 0 AND e.archived_at IS NULL;

INSERT INTO leave_balance_movements (id, balance_id, leave_request_id, kind, days, note)
SELECT gen_random_uuid(), lb.id, l.id, 'usage', l.days, 'ترحيل رصيد افتتاحي'
FROM leave_requests l
JOIN leave_types t ON t.id = l.leave_type_id
JOIN leave_balances lb
  ON lb.employee_id = l.employee_id
 AND lb.leave_type_id = l.leave_type_id
 AND lb.year = EXTRACT(YEAR FROM l.start_date)::int
WHERE l.status = 'approved' AND t.track_balance = true
ON CONFLICT DO NOTHING;

UPDATE leave_balances lb
SET used = COALESCE((
  SELECT sum(m.days) FROM leave_balance_movements m
  WHERE m.balance_id = lb.id AND m.kind = 'usage'
), 0);
