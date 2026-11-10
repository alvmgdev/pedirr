# Pedirr

Sports content requests for [Sportarr](https://sportarr.net). Users browse the Sportarr Hub catalog, request whole seasons or single events, and Pedirr monitors and searches for them in your Sportarr instance once approved.

- Search leagues, teams, seasons and events, with a seven-day upcoming schedule
- Season and event requests with deduplication, shared subscriptions and availability checks
- Manual review or automatic approval by role and by user
- Background fulfillment that never changes your existing league monitoring settings
- Email (SMTP) and Discord notifications
- English and Spanish interface; registration closed by default

Writes to Sportarr require Sportarr 4.1.11 or a later 4.1 release.

Source code, issues and changelog: [github.com/alvmgdev/pedirr](https://github.com/alvmgdev/pedirr).

## Tags

| Tag      | Meaning                                    |
| -------- | ------------------------------------------ |
| `latest` | Latest stable release                      |
| `0.1`    | Latest patch of the 0.1 line (recommended) |
| `0.1.0`  | Exact release                              |

Images are published for `linux/amd64` and `linux/arm64`. One image runs the database migrations, the API and web interface, and the background worker.

## Installation

Create a directory with these two files.

`compose.yaml`:

```yaml
name: pedirr
x-pedirr-image: &pedirr-image ${PEDIRR_IMAGE:-docker.io/alvmgdev/pedirr:0.1}
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
# Back it up: without it, stored Sportarr, SMTP and Discord credentials cannot be decrypted.
SETTINGS_ENCRYPTION_KEY=
LOG_LEVEL=info
HUB_REQUESTS_PER_MINUTE=20
```

Start Pedirr and create the first administrator (password of 12-128 characters):

```sh
docker compose up -d
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' \
  docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD app node apps/server/dist/bootstrap-admin.js
```

Open `APP_ORIGIN`, sign in, and configure Sportarr and notifications from the administration screen. Put a TLS reverse proxy in front of Pedirr before exposing it publicly.

## Data and backups

The Pedirr containers are stateless. All data lives in two named volumes:

- `postgres-data`: users, sessions, requests and history, encrypted settings and notification records. Back this up.
- `redis-data`: queues, caches and rate limits. Pending work is recovered from PostgreSQL if it is lost.

```sh
docker compose exec -T postgres pg_dump -U pedirr pedirr > pedirr-$(date +%F).sql
```

`docker compose down` keeps the data; `docker compose down -v` deletes it.

## Upgrading

```sh
docker compose pull && docker compose up -d
```

Migrations run automatically before the API and worker start.

## Health and API

- Liveness: `/api/v1/health/live`
- Readiness (database, Redis, worker): `/api/v1/health/ready`
- API documentation: `/api/docs` (OpenAPI at `/api/openapi.json`)

## License

[GPL-3.0-or-later](https://github.com/alvmgdev/pedirr/blob/main/LICENSE).
