#!/usr/bin/env bash
# BATAWIL HRMS - restore the latest (or given) dump into a throwaway database
# and verify core row counts. Never touches the production database.
# Usage:
#   ./deploy/restore-verify.sh                       # latest unencrypted dump
#   ./deploy/restore-verify.sh /path/to/file.dump    # specific dump
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/batawil}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[restore] missing $ENV_FILE" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  dump_file="$1"
else
  dump_file="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'batawil-*.dump' -printf '%T@ %p\n' \
    | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi

if [[ -z "${dump_file:-}" || ! -f "$dump_file" ]]; then
  echo "[restore] no unencrypted dump found (encrypted .age files must be decrypted first)" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

temp_db="batawil_verify_$(date -u +%Y%m%d%H%M%S)"
cleanup() {
  compose exec -T db dropdb -U batawil --if-exists "$temp_db" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[restore] creating $temp_db"
compose exec -T db createdb -U batawil "$temp_db"

echo "[restore] restoring $dump_file"
compose exec -T db pg_restore -U batawil -d "$temp_db" --no-owner --no-privileges < "$dump_file"

echo "[restore] verifying row counts"
counts="$(compose exec -T db psql -U batawil -d "$temp_db" -At -F= -c "
  SELECT 'migrations', count(*) FROM schema_migrations
  UNION ALL SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'branches', count(*) FROM branches
  UNION ALL SELECT 'employees', count(*) FROM employees
  UNION ALL SELECT 'attendance_submissions', count(*) FROM attendance_submissions
  UNION ALL SELECT 'daily_attendance', count(*) FROM daily_attendance
  UNION ALL SELECT 'monthly_attendance', count(*) FROM monthly_attendance
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;
")"
echo "$counts"

users="$(printf '%s\n' "$counts" | awk -F= '$1=="users"{print $2}')"
employees="$(printf '%s\n' "$counts" | awk -F= '$1=="employees"{print $2}')"
migrations="$(printf '%s\n' "$counts" | awk -F= '$1=="migrations"{print $2}')"

if [[ "${users:-0}" -lt 1 || "${employees:-0}" -lt 1 || "${migrations:-0}" -lt 7 ]]; then
  echo "[restore] verification failed: users=$users employees=$employees migrations=$migrations" >&2
  exit 1
fi

echo "[restore] verification passed; dropping $temp_db"
