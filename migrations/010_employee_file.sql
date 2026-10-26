-- BATAWIL HRMS - Employee file: job titles, reporting line, contracts and history.

CREATE TABLE job_titles (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX job_titles_name_uq ON job_titles (lower(name));
CREATE INDEX job_titles_department_idx ON job_titles (department_id);

ALTER TABLE employees
  ADD COLUMN job_title_id uuid REFERENCES job_titles(id) ON DELETE SET NULL,
  ADD COLUMN manager_id uuid REFERENCES employees(id) ON DELETE SET NULL;
CREATE INDEX employees_manager_idx ON employees (manager_id);

CREATE TABLE employee_contracts (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_no text NOT NULL DEFAULT '',
  contract_type text NOT NULL DEFAULT 'permanent'
    CHECK (contract_type IN ('permanent', 'fixed', 'probation', 'part_time')),
  start_date date NOT NULL,
  end_date date,
  base_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'terminated')),
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX employee_contracts_employee_idx ON employee_contracts (employee_id, start_date DESC);
CREATE UNIQUE INDEX employee_contracts_active_uq ON employee_contracts (employee_id) WHERE status = 'active';

CREATE TABLE employee_history (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  change_type text NOT NULL
    CHECK (change_type IN ('hired', 'updated', 'status_changed', 'salary_changed', 'transferred',
                           'contract_added', 'contract_updated', 'archived',
                           'document_added', 'document_updated', 'document_deleted')),
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_history_employee_idx ON employee_history (employee_id, created_at DESC);

ALTER TABLE attachments
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN document_type text NOT NULL DEFAULT 'other'
    CHECK (document_type IN ('contract', 'national_id', 'certificate', 'medical', 'other')),
  ADD COLUMN expires_at date;

-- Turn every job title already typed on employee records into a managed master record.
INSERT INTO job_titles (id, name)
SELECT gen_random_uuid(), names.name
FROM (SELECT DISTINCT trim(job_title) AS name FROM employees WHERE trim(job_title) <> '') AS names
ON CONFLICT DO NOTHING;

UPDATE employees e
SET job_title_id = jt.id
FROM job_titles jt
WHERE e.job_title_id IS NULL
  AND trim(e.job_title) <> ''
  AND lower(trim(e.job_title)) = lower(jt.name);
