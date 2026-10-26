-- Audit rows are append-only, so the previous ON DELETE SET NULL action could
-- never run for branch deletion (it fires the blocking BEFORE UPDATE trigger).
-- Keep the historical branch id instead of referencing a live branch row.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_branch_id_fkey;
