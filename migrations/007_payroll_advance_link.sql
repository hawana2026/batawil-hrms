ALTER TABLE advance_transactions
  ADD COLUMN payroll_record_id uuid REFERENCES payroll_records(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX advance_transactions_payroll_uq
  ON advance_transactions (payroll_record_id, advance_id)
  WHERE payroll_record_id IS NOT NULL;
