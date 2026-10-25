-- BATAWIL HRMS - Phase 1 core schema
-- Central identity, branches, sessions and append-only audit log.

CREATE TABLE roles (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  name_ar text NOT NULL,
  description_ar text NOT NULL DEFAULT '',
  all_permissions boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_key_uq ON roles (key);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  name_ar text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  city text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_code_uq ON branches (upper(code));

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  full_name text NOT NULL,
  email text,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  role_id uuid NOT NULL REFERENCES roles(id),
  active boolean NOT NULL DEFAULT true,
  all_branches boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  session_version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_role_idx ON users (role_id);

ALTER TABLE branches
  ADD CONSTRAINT branches_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE user_branch_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);
CREATE INDEX user_branch_access_branch_idx ON user_branch_access (branch_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  username text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  success boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_username_idx ON login_attempts (lower(username), created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, created_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_username text NOT NULL DEFAULT '',
  action text NOT NULL,
  entity_type text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_branch_idx ON audit_logs (branch_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

CREATE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER audit_logs_no_mutation
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
