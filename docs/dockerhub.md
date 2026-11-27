# Pedirr

Sports content requests for [Sportarr](https://sportarr.net). Users browse the Sportarr Hub catalog, request single events (administrators can also request whole seasons), and Pedirr monitors and searches for them in your Sportarr instance once approved. One installation can also be resold: resellers get their own address and clients, all served by the same Sportarr.

- Search leagues, teams, seasons and events, with this week's schedule from a local copy of Hub that the worker keeps up to date
- Event and season requests with deduplication, shared subscriptions and availability checks
- Fight cards requested by part (Early Prelims, Prelims, Main Card…), with each user's own status
- Plans as content packages (whole sports or single leagues), and optional weekly request limits and expiration dates per user
- Resellers: separate environments at `APP_ORIGIN/<code>/` with their own clients, a package of plans, an optional client limit and their own notification settings, isolated from each other
- Manual review or automatic approval by role and by user
- Private issue reports with comments and a resolution workflow
- Background fulfillment that never changes your existing league monitoring settings
- Email (SMTP), Discord and Telegram notifications; one Telegram bot for the platform, with a group or channel per environment
- English and Spanish interface, dates in each browser's time zone, registration closed by default

Writes to Sportarr require Sportarr 4.1.11 or a later 4.1 release.

Source code, issues and changelog: [github.com/alvmgdev/pedirr](https://github.com/alvmgdev/pedirr).

## Image

Images are published for `linux/amd64` and `linux/arm64`. One image runs the database migrations, the API and web interface, and the background worker.

## Installation

Create a directory with these two files.

`compose.yaml`:

```yaml
name: pedirr
x-pedirr-image: &pedirr-image ${PEDIRR_IMAGE:-docker.io/alvmgdev/pedirr:latest}
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: pedirr
      POSTGRES_USER: pedirr
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pedirr -d pedirr"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  migrate:
    image: *pedirr-image
    command: ["node_modules/.bin/prisma", "migrate", "deploy"]
    environment:
      DATABASE_URL: postgresql://pedirr:${POSTGRES_PASSWORD}@postgres:5432/pedirr
    depends_on:
      postgres:
        condition: service_healthy
  app:
    image: *pedirr-image
    ports:
      - "${APP_PORT:-3000}:3000"
    environment: &app-environment
      DATABASE_URL: postgresql://pedirr:${POSTGRES_PASSWORD}@postgres:5432/pedirr
      REDIS_URL: redis://redis:6379
      LOG_LEVEL: ${LOG_LEVEL:-info}
      HUB_REQUESTS_PER_MINUTE: ${HUB_REQUESTS_PER_MINUTE:-20}
      HUB_TIMEOUT_SECONDS: ${HUB_TIMEOUT_SECONDS:-20}
      TRUST_PROXY: ${TRUST_PROXY:-}
      SEARCH_RETRY_MINUTES: ${SEARCH_RETRY_MINUTES:-60}
      APP_ORIGIN: ${APP_ORIGIN:?Set APP_ORIGIN}
      SESSION_SECRET: ${SESSION_SECRET:?Set SESSION_SECRET}
      SETTINGS_ENCRYPTION_KEY: ${SETTINGS_ENCRYPTION_KEY:?Set SETTINGS_ENCRYPTION_KEY}
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://localhost:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 20s
      timeout: 5s
      retries: 5
    restart: unless-stopped
  worker:
    image: *pedirr-image
    command: ["node", "apps/server/dist/worker.js"]
    environment: *app-environment
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    restart: unless-stopped
volumes:
  postgres-data:
  redis-data:
```

`.env`:

```sh
# Long random URL-safe value, e.g. openssl rand -hex 24
POSTGRES_PASSWORD=
# Exact browser origin, including scheme and port
APP_ORIGIN=http://localhost:3000
APP_PORT=3000
# At least 32 random characters, e.g. openssl rand -hex 32
SESSION_SECRET=
# Exactly 64 hexadecimal characters: openssl rand -hex 32
# Back it up: without it, stored Sportarr, SMTP, Discord and Telegram credentials cannot be decrypted.
SETTINGS_ENCRYPTION_KEY=
LOG_LEVEL=info
HUB_REQUESTS_PER_MINUTE=20
# Seconds a Hub call may take before giving up (1-120); raise it while Hub is slow
HUB_TIMEOUT_SECONDS=20
# Behind a reverse proxy: hop count (1) or proxy addresses/CIDR. Empty = direct.
TRUST_PROXY=
# Minutes before repeating an automatic search that found nothing (15-10080)
SEARCH_RETRY_MINUTES=60
```

Start Pedirr and create the first administrator (password of 12-128 characters):

```sh
docker compose up -d
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' \
  docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD app node apps/server/dist/bootstrap-admin.js
```

Open `APP_ORIGIN`, sign in, and configure Sportarr and notifications from the administration screen. Put a TLS reverse proxy in front of Pedirr before exposing it publicly, and set `TRUST_PROXY` to that proxy (for example `1`) so rate limits apply to each client rather than to the proxy.

## Data and backups

The Pedirr containers are stateless. All data lives in two named volumes:

- `postgres-data`: users, resellers and plans, sessions, requests and history, encrypted settings, notification records and the local copy of Hub's leagues and schedule. Back this up.
- `redis-data`: queues, caches and rate limits. Pending work is recovered from PostgreSQL if it is lost.

```sh
docker compose exec -T postgres pg_dump -U pedirr pedirr > pedirr-$(date +%F).sql
```

`docker compose down` keeps the data; `docker compose down -v` deletes it.

## Upgrading

Back up the database first (see above), then:

```sh
docker compose pull && docker compose up -d
```

Migrations run automatically before the API and worker start.

### From 1.x to 2.0

- Existing accounts keep working, and so do their sessions. Administrators become the platform administrators, and users become platform users with no plan or limits, so they can request everything as before.
- Requests, issues and settings are kept, including the encrypted Sportarr, SMTP and Discord credentials. No new environment variables are needed.
- Whole seasons can only be requested by administrators; the per-user season permission is gone. Users request single events.
- Users no longer set a time zone: dates follow each browser's.
- After the upgrade the worker copies Hub's leagues and the schedule from a week back to two weeks ahead, paced to a share of `HUB_REQUESTS_PER_MINUTE`. Until the copy completes, the catalog reads Hub directly. If Hub is down, the copy is retried every hour.
- Reseller addresses are paths on the same origin (`APP_ORIGIN/<code>/`), so a reverse proxy that already serves Pedirr needs no change.
- Telegram, if you set it up, needs outbound HTTPS from the worker to `api.telegram.org`. Pedirr polls the bot only while a group or channel is being linked, so it needs no public address.

## Health and API

- Liveness: `/api/v1/health/live`
- Readiness (database, Redis, worker): `/api/v1/health/ready`
- API documentation: `/api/docs` (OpenAPI at `/api/openapi.json`)

## License

[GPL-3.0-or-later](https://github.com/alvmgdev/pedirr/blob/main/LICENSE).
