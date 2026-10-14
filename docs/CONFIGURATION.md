# Configuration reference

Create a .env file in the project root (it is gitignored) with the variables below. Only these are read at runtime; secrets must never be committed.

Generate secrets: `openssl rand -base64 48` (JWT_SECRET) and `openssl rand -hex 32` (DATA_ENCRYPTION_KEY).

```dotenv
# --- Runtime --------------------------------------------------------------
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
APP_VERSION=0.1.0
GIT_SHA=dev
TRUST_PROXY=0                # number of reverse proxies in front of the API

# --- Database -------------------------------------------------------------
# Runtime role: non-owner, non-superuser, subject to row-level security.
DATABASE_URL=postgres://nexus_app:nexus_app_dev_pw@localhost:5432/nexus
# Migrations / pg-boss schema / platform scripts: owner role.
MIGRATOR_DATABASE_URL=postgres://postgres:postgres@localhost:5432/nexus
NEXUS_APP_DB_PASSWORD=nexus_app_dev_pw   # used when the migration creates the nexus_app role

# --- Secrets (generate real values; never commit) ------------------------------
# openssl rand -base64 48
JWT_SECRET=change-me-change-me-change-me-change-me-change-me
# openssl rand -hex 32   (rotate with "2:<new>,1:<old>" — newest version encrypts, all versions decrypt)
DATA_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
METRICS_TOKEN=

# --- HTTP -----------------------------------------------------------------
CORS_ORIGINS=http://localhost:5173      # comma-separated allow-list (required in production)
SWAGGER=true                            # Swagger UI /api/docs, Redoc /api/redoc, spec /api/docs/openapi.json (default on, also in production; SWAGGER=false disables)
#APP_BASE_URL=https://api.example.test   # `servers` entry of the OpenAPI document
#DOCS_BASIC_AUTH_USER=docs               # optional HTTP Basic gate in front of the docs (staging)
#DOCS_BASIC_AUTH_PASS=change-me-please

# --- Mail -----------------------------------------------------------------
MAIL_DRIVER=console                     # console | smtp  (console is rejected in production)
SMTP_URL=smtp://localhost:1025
MAIL_FROM=Zellavora Nexus <no-reply@example.test>

# --- Files ----------------------------------------------------------------
STORAGE_DRIVER=local
STORAGE_DIR=./.storage
STORAGE_QUOTA_BYTES=1073741824          # default per-organization quota (plans may override)
MAX_UPLOAD_BYTES=10485760

# --- Jobs / flags ---------------------------------------------------------------
JOBS_DRIVER=pgboss                      # pgboss | inline (tests)
# Module flags default ON in development/test and OFF in production unless overridden:
# MODULE_FLAGS_DEFAULT=off
# OUTBOUND_REQUIRE_HTTPS=true           # webhooks: https only (defaults to true in production)

```n
