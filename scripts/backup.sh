#!/usr/bin/env bash
# Logical backup (custom format) with retention. RPO: the backup interval (default 24h; use WAL archiving for < 15 min).
# Usage: DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/nexus ./scripts/backup.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (use the migrator/owner role)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/nexus-${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"
echo "[backup] starting ${FILE}"
pg_dump --format=custom --no-owner --no-privileges --file="${FILE}" "${DATABASE_URL}"
SIZE="$(wc -c < "${FILE}" | tr -d ' ')"
sha256sum "${FILE}" > "${FILE}.sha256"
echo "[backup] done: ${SIZE} bytes"

# prune old backups
find "${BACKUP_DIR}" -name 'nexus-*.dump*' -mtime +"${RETENTION_DAYS}" -delete

# optional: record the run through the API (platform admin token) so alerts can fire on staleness
if [[ -n "${NEXUS_API_URL:-}" && -n "${NEXUS_ADMIN_TOKEN:-}" ]]; then
  curl -fsS -X POST "${NEXUS_API_URL}/api/v1/platform/backups" \
    -H "Authorization: Bearer ${NEXUS_ADMIN_TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"status\":\"completed\",\"location\":\"${FILE}\",\"sizeBytes\":${SIZE}}" >/dev/null || echo "[backup] warning: could not record the run"
fi
