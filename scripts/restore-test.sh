#!/usr/bin/env bash
# Restores a dump into a scratch database and runs sanity queries. RTO target: < 1 hour for a typical tenant volume.
# Usage: ADMIN_DATABASE_URL=postgres://postgres@host/postgres ./scripts/restore-test.sh backups/nexus-XXXX.dump
set -euo pipefail

DUMP="${1:?path to a pg_dump -Fc file}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL (a role that can CREATE DATABASE) is required}"
SCRATCH="nexus_restore_$(date -u +%s)"

if [[ -f "${DUMP}.sha256" ]]; then sha256sum -c "${DUMP}.sha256"; fi

echo "[restore] creating ${SCRATCH}"
psql "${ADMIN_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${SCRATCH}" >/dev/null
BASE="${ADMIN_DATABASE_URL%/*}"
TARGET="${BASE}/${SCRATCH}"
cleanup() { psql "${ADMIN_DATABASE_URL}" -c "DROP DATABASE IF EXISTS ${SCRATCH}" >/dev/null || true; }
trap cleanup EXIT

pg_restore --no-owner --no-privileges --dbname="${TARGET}" "${DUMP}"

check() { # name, sql
  local out; out="$(psql "${TARGET}" -At -v ON_ERROR_STOP=1 -c "$2")"
  echo "[restore] $1: ${out}"
  [[ -n "${out}" ]]
}
check "organizations"      "SELECT count(*) FROM organizations"
check "users"              "SELECT count(*) FROM users"
check "audit events"       "SELECT count(*) FROM audit_events"
check "migrations applied" "SELECT count(*) FROM knex_migrations"
check "rls enabled tables" "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relkind='r'"
check "orphan memberships" "SELECT count(*) FROM organization_memberships m LEFT JOIN organizations o ON o.id=m.organization_id WHERE o.id IS NULL"
echo "[restore] OK: backup is restorable"
