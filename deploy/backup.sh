#!/usr/bin/env bash
# BATAWIL HRMS - encrypted-at-rest optional PostgreSQL backup.
# Run on the server from the project directory (or via cron).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/batawil}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[backup] missing $ENV_FILE" >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="$BACKUP_DIR/batawil-$timestamp.dump"

echo "[backup] dumping database to $dump_file"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db \
  pg_dump -U batawil -d batawil --format=custom --compress=9 > "$dump_file"

if [[ ! -s "$dump_file" ]]; then
  echo "[backup] dump is empty" >&2
  rm -f "$dump_file"
  exit 1
fi
chmod 600 "$dump_file"

echo "[backup] verifying archive readability"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db \
  pg_restore --list < "$dump_file" > /dev/null

sha256sum "$dump_file" > "$dump_file.sha256"
chmod 600 "$dump_file.sha256"

checksum_file="$dump_file.sha256"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  if ! command -v age > /dev/null 2>&1; then
    echo "[backup] BACKUP_AGE_RECIPIENT is set but age is not installed" >&2
    exit 1
  fi
  echo "[backup] encrypting with age"
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump_file.age" "$dump_file"
  rm -f "$dump_file" "$checksum_file"
  dump_file="$dump_file.age"
  checksum_file="$dump_file.sha256"
  sha256sum "$dump_file" > "$checksum_file"
  chmod 600 "$dump_file" "$checksum_file"
else
  echo "[backup] warning: backup is unencrypted; install age and set BACKUP_AGE_RECIPIENT" >&2
fi

if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  if ! command -v rclone > /dev/null 2>&1; then
    echo "[backup] BACKUP_RCLONE_REMOTE is set but rclone is not installed" >&2
    exit 1
  fi
  echo "[backup] copying to $BACKUP_RCLONE_REMOTE"
  rclone copyto "$dump_file" "$BACKUP_RCLONE_REMOTE/$(basename "$dump_file")"
  rclone copyto "$checksum_file" "$BACKUP_RCLONE_REMOTE/$(basename "$checksum_file")"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'batawil-*.dump' -o -name 'batawil-*.dump.age' \
  -o -name 'batawil-*.dump.sha256' -o -name 'batawil-*.dump.age.sha256' \) \
  -mtime +"$KEEP_DAYS" -delete

echo "[backup] done: $dump_file"
echo "[backup] backups contain employee data, password hashes, attachments and audit history."
