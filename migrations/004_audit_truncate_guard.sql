-- BATAWIL HRMS - Phase 1 audit hardening
-- Row triggers do not fire for TRUNCATE; block it explicitly.

CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
