-- BATAWIL HRMS - Phase 2 HR operations schema
-- Employees, departments, attendance, requests, approvals and payroll review data.

CREATE TABLE departments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_name_uq ON departments (lower(name));

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value) VALUES
  ('company', '{"name":"BATAWIL","currency":"YER","printFooter":"نظام الموارد البشرية BATAWIL"}'::jsonb),
  ('attendance', '{"workStart":"08:00","workEnd":"16:00","lateGraceMinutes":10,"weekendDays":[5,6]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE SEQUENCE employee_no_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE employees (
  id uuid PRIMARY KEY,
  employee_no text NOT NULL,
  full_name text NOT NULL,
  phone text NOT NULL,
  national_id text,
  branch_id uuid NOT NULL REFERENCES branches(id),
  department_id uuid REFERENCES departments(id),
  job_title text NOT NULL DEFAULT '',
  hire_date date NOT NULL,
  base_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'leave', 'suspended', 'resigned', 'transferred')),
  notes text NOT NULL DEFAULT '',
  termination_date date,
  termination_reason text,
  archived_at timestamptz,
  archive_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employees_no_uq ON employees (lower(employee_no));
CREATE UNIQUE INDEX employees_national_uq ON employees (national_id) WHERE national_id IS NOT NULL AND national_id <> '';
CREATE INDEX employees_branch_idx ON employees (branch_id, status);
CREATE INDEX employees_department_idx ON employees (department_id);
CREATE INDEX employees_phone_idx ON employees (phone);
CREATE INDEX employees_archived_idx ON employees (archived_at);

CREATE TABLE attendance_submissions (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  work_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  notes text NOT NULL DEFAULT '',
  prepared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejection_reason text,
  last_corrected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_corrected_at timestamptz,
  correction_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX attendance_submissions_branch_date_uq ON attendance_submissions (branch_id, work_date);
CREATE INDEX attendance_submissions_date_idx ON attendance_submissions (work_date DESC);
CREATE INDEX attendance_submissions_status_idx ON attendance_submissions (status);

CREATE TABLE daily_attendance (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES attendance_submissions(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id),
  manual_name text,
  status text NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'absent', 'leave', 'permission', 'mission', 'weekly_rest', 'late', 'excused_absence')),
  check_in time,
  check_out time,
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0 AND late_minutes <= 1440),
  work_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (work_hours >= 0 AND work_hours <= 24),
  reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((employee_id IS NOT NULL) <> (manual_name IS NOT NULL)),
  CHECK (manual_name IS NULL OR length(trim(manual_name)) > 0)
);
CREATE UNIQUE INDEX daily_attendance_employee_uq ON daily_attendance (submission_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX daily_attendance_manual_uq ON daily_attendance (submission_id, lower(manual_name)) WHERE manual_name IS NOT NULL;
CREATE INDEX daily_attendance_employee_idx ON daily_attendance (employee_id);

CREATE TABLE monthly_attendance (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  missing_days_confirmed boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  prepared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX monthly_attendance_branch_period_uq ON monthly_attendance (branch_id, year, month);
CREATE INDEX monthly_attendance_period_idx ON monthly_attendance (year DESC, month DESC);

CREATE TABLE monthly_attendance_overrides (
  id uuid PRIMARY KEY,
  monthly_id uuid NOT NULL REFERENCES monthly_attendance(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  day integer NOT NULL CHECK (day BETWEEN 1 AND 31),
  status text NOT NULL
    CHECK (status IN ('present', 'absent', 'leave', 'permission', 'mission', 'weekly_rest', 'late', 'excused_absence')),
  note text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX monthly_overrides_row_uq ON monthly_attendance_overrides (monthly_id, employee_id, day);
CREATE INDEX monthly_overrides_employee_idx ON monthly_attendance_overrides (employee_id);

CREATE TABLE employee_transfers (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  from_branch_id uuid NOT NULL REFERENCES branches(id),
  to_branch_id uuid NOT NULL REFERENCES branches(id),
  from_department_id uuid REFERENCES departments(id),
  to_department_id uuid REFERENCES departments(id),
  effective_date date NOT NULL,
  reason text NOT NULL,
  notes text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  decision_note text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_branch_id <> from_branch_id OR to_department_id IS DISTINCT FROM from_department_id)
);
CREATE UNIQUE INDEX employee_transfers_pending_uq ON employee_transfers (employee_id) WHERE status = 'pending';
CREATE INDEX employee_transfers_employee_idx ON employee_transfers (employee_id, created_at DESC);
CREATE INDEX employee_transfers_effective_idx ON employee_transfers (effective_date);

CREATE TABLE new_employee_requests (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  phone text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  department_id uuid REFERENCES departments(id),
  job_title text NOT NULL DEFAULT '',
  proposed_salary numeric(14,2) NOT NULL DEFAULT 0 CHECK (proposed_salary >= 0),
  start_date date NOT NULL,
  notes text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'completed')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  decision_note text,
  employee_id uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX new_employee_requests_branch_idx ON new_employee_requests (branch_id, status);
CREATE INDEX new_employee_requests_status_idx ON new_employee_requests (status);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  leave_type text NOT NULL
    CHECK (leave_type IN ('annual', 'sick', 'unpaid', 'emergency', 'permission', 'other')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  days integer NOT NULL CHECK (days > 0 AND days <= 366),
  reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_employee_idx ON leave_requests (employee_id, start_date DESC);
CREATE INDEX leave_requests_branch_idx ON leave_requests (branch_id, status);
CREATE INDEX leave_requests_dates_idx ON leave_requests (start_date, end_date);

CREATE TABLE advance_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  request_date date NOT NULL,
  installments integer NOT NULL DEFAULT 1 CHECK (installments >= 1 AND installments <= 60),
  deduction_method text NOT NULL DEFAULT 'installments'
    CHECK (deduction_method IN ('installments', 'one_time')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_hr', 'pending_finance', 'approved', 'rejected', 'disbursed')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  hr_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  hr_approved_at timestamptz,
  finance_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  finance_approved_at timestamptz,
  disbursed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  disbursed_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advance_requests_employee_idx ON advance_requests (employee_id, request_date DESC);
CREATE INDEX advance_requests_branch_idx ON advance_requests (branch_id, status);

CREATE TABLE advance_transactions (
  id uuid PRIMARY KEY,
  advance_id uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('disbursement', 'deduction')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transaction_date date NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advance_transactions_advance_idx ON advance_transactions (advance_id, transaction_date);

CREATE TABLE payroll_records (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  base_salary numeric(14,2) NOT NULL DEFAULT 0,
  allowances numeric(14,2) NOT NULL DEFAULT 0,
  deductions numeric(14,2) NOT NULL DEFAULT 0,
  advance_deduction numeric(14,2) NOT NULL DEFAULT 0,
  advance_outstanding numeric(14,2) NOT NULL DEFAULT 0,
  present_days integer NOT NULL DEFAULT 0,
  absent_days integer NOT NULL DEFAULT 0,
  leave_days integer NOT NULL DEFAULT 0,
  late_count integer NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  review_status text NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft', 'reviewed', 'approved')),
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payroll_records_employee_period_uq ON payroll_records (employee_id, year, month);
CREATE INDEX payroll_records_period_idx ON payroll_records (year DESC, month DESC, branch_id);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL
    CHECK (entity_type IN ('attendance_day', 'attendance_month', 'leave', 'advance', 'transfer', 'new_hire')),
  entity_id uuid NOT NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status, requested_at DESC);
CREATE INDEX approval_requests_branch_idx ON approval_requests (branch_id, status);
CREATE INDEX approval_requests_requested_idx ON approval_requests (requested_by);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL
    CHECK (owner_type IN ('employee', 'leave', 'advance', 'new_hire', 'transfer')),
  owner_id uuid NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  content bytea NOT NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_owner_idx ON attachments (owner_type, owner_id, created_at DESC);
