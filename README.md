# Pedirr

Sports content requests for Sportarr. The project is under active implementation; this revision delivers the deployment foundation, authentication, user administration, metadata discovery, request workflow, and encrypted Sportarr settings APIs; remaining features are tracked in docs/progress.md.

## Development

Requires Node.js 22 and Docker Compose. Run `npm ci`, `npm run db:generate`, `npm run check`, `npm run build`, and `npm test`.

For source development, export `DATABASE_URL` and `REDIS_URL` pointing to development services reachable from your shell, plus `APP_ORIGIN`, `SESSION_SECRET`, and `SETTINGS_ENCRYPTION_KEY` as described below. Shell commands do not automatically load the Compose `.env` file. The default Compose database and Redis ports are private; use Docker for the standard installation, or provide separate reachable development services.

Run `npm run db:migrate` before starting the API. In separate terminals, run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web`. API and worker use TypeScript's compiler through `ts-node` with Node's watch mode, preserving Nest dependency-injection and validation metadata. These commands reload imported source files on change. For the default Vite proxy, export `PORT=3187` for the API and `APP_ORIGIN=http://localhost:5173`; open the frontend at that exact origin. Stop an existing application on port 3187 before using it for development.

## Docker

Copy `.env.example` to `.env`, replace the database password with a long random URL-safe value, set a random `SESSION_SECRET`, generate `SETTINGS_ENCRYPTION_KEY` with `openssl rand -hex 32`, then run `docker compose up --build -d`. PostgreSQL and Redis are private to the Compose network. Migrations run before the API and worker start.

- Liveness: `http://localhost:3000/api/v1/health/live`
- Readiness (database, Redis, worker): `http://localhost:3000/api/v1/health/ready`
- API documentation: `http://localhost:3000/api/docs`
- OpenAPI: `http://localhost:3000/api/openapi.json`

Use a TLS reverse proxy before exposing the finished application publicly. Persistent data lives in the Compose volumes. Do not use `docker compose down -v` unless you intend to delete it.

See [API research](docs/api-research.md), [architecture](docs/architecture.md), and [implementation status](docs/progress.md).

## Initial administrator

After migrations, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell and run:

```sh
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD app node apps/server/dist/bootstrap-admin.js
```

The password must be 12-128 characters. The command refuses to run if an administrator already exists. Registration starts disabled. Administrators can create users with POST `/api/v1/admin/users`, list users with GET `/api/v1/admin/users?page=1`, and update roles, active status, or auto-approval with PATCH `/api/v1/admin/users/{id}`. Disabling or changing a role revokes existing sessions. The last active administrator cannot be disabled or demoted.

Set `APP_ORIGIN` to the exact browser origin, including the port. Set `SESSION_SECRET` to at least 32 cryptographically random characters and keep it identical across API replicas. Session cookies are Secure on HTTPS. Unsafe API requests require an exact Origin header and the `x-csrf-token` obtained from GET `/api/v1/auth/csrf`. Fetch a new token after login, because tokens are bound to the current session. Password changes revoke every existing session.

Authentication tests run an HTTP server with mocked PostgreSQL and Redis. They cover rejected unauthenticated reads, CSRF and Origin checks, cookie attributes, logout revocation, disabled users, closed registration, and rate limiting. Docker readiness separately verifies real database and Redis connectivity and worker heartbeat.

## Approval and registration policies

GET and PATCH `/api/v1/admin/policies` require administrator access. PATCH accepts all three boolean fields: `registrationEnabled`, `userAutoApprove`, and `adminAutoApprove`. All default to false. A user's `autoApprove` field overrides their role when true or false; null inherits the role policy. New requests consume this policy transactionally. An explicit user setting overrides the role policy. Existing requests retain their status when another user subscribes.

Run the PostgreSQL concurrency test against a running Compose database:

```sh
docker compose run --rm --no-deps app node apps/server/test/integration/users.cjs
```

This test creates an isolated temporary database schema, applies migrations, verifies simultaneous administrator changes and session revocation, and removes the schema afterward. Build the app image first after source changes.

## Metadata discovery

Authenticated discovery routes live under `/api/v1/catalog`: `search?q=`, `leagues?page=`, `leagues/{id}`, `leagues/{id}/seasons?page=`, `seasons/{id}`, `teams/{id}`, `events`, `events/{id}`, `upcoming?page=`, and `popular`. Event filters are `league`, `season`, `team`, `from`, `to`, and `page`; dates use YYYY-MM-DD. Identifiers remain in the provider's namespace, with UUID, short ID, and TheSportsDB ID kept separate.

Sportarr Hub is the initial implementation of the replaceable `MetadataProvider` interface. Redis shares cached responses, request locks, an outbound budget, and upstream cooldowns across API replicas. `HUB_REQUESTS_PER_MINUTE` defaults to a conservative 20; this is an application limit, not a claim about Hub's quota. A 503 response with `METADATA_BUSY` includes `retryAfterSeconds`; clients should retry after that delay. Upstream 429 Retry-After values establish a shared cooldown. Requests time out after 10 seconds and do not follow redirects.

Event listings within a season are cached for one hour to allow complete scans under the shared quota; other events are cached for two minutes, searches/details/seasons for five minutes, and league lists for one hour. Cache expiry controls when Pedirr checks Hub again; it does not guarantee when Hub refreshes its sources. `upcoming` filters scheduled UTC timestamps over the next seven days and returns `hasMore`; an empty filtered page can still have a next page. `popular` ranks non-rejected league requests in this installation and is empty before requests exist. It is not an upstream popularity chart.

## Requests and moderation

POST `/api/v1/requests` accepts `kind` (`season` or `event`) and a Hub `identifier`. A season is always selected explicitly; the server resolves its league from metadata. The response contains `created` and `request`. Duplicate identifiers and aliases resolve to the same canonical request and subscribe the caller without repeating approval or fulfillment work.

GET `/api/v1/requests` accepts `page`, `status`, and `mine=true`; GET `/api/v1/requests/{id}` includes history and the caller's subscription status. Users can see shared requests, but other subscribers' identities are omitted. POST `/api/v1/requests/{id}/review` requires an administrator, a `decision` (`approve` or `reject`), the current integer `version`, and a nonempty `reason` for rejection. Only pending requests can be reviewed. A stale or concurrent decision returns `REQUEST_CHANGED` with HTTP 409.

Creation, subscription, history and outbox records commit atomically. Approval records durable integration work. The worker reconciles with Sportarr before creating anything and skips searches for imported events. Before creating a new request, the API checks for an existing Pedirr request and for imported content in Sportarr.

The database workflow test uses mocked upstream metadata with real PostgreSQL transactions:

```sh
docker compose run --rm --no-deps app node apps/server/test/integration/requests.cjs
```

It checks simultaneous duplicate submissions, conflicting moderation, role/user policies, authorization, subscriber privacy and rollback when the outbox write fails, inside a disposable schema.

## Sportarr settings

Administrator endpoints:

- GET `/api/v1/admin/settings/sportarr`: URL, selected defaults, and a `hasApiKey` flag. Never returns credentials or ciphertext.
- POST `/api/v1/admin/settings/sportarr/test`: accepts `url` and `apiKey`; checks application identity, authenticated league access, root folders and quality profiles. Returns the detected version and selectable defaults.
- PUT `/api/v1/admin/settings/sportarr`: accepts `url`, `apiKey`, `rootFolderId`, and `qualityProfileId`. Tests the connection and validates both defaults before saving.

Omit `apiKey` to reuse the stored credential for the same normalized URL. A different URL requires a new key. Private HTTP installations are supported. URL prefixes are preserved; credentials, query strings and fragments in the URL are rejected, and redirects are not followed. The client sends credentials only in `X-Api-Key`, uses a 15-second timeout, and does not expose upstream response bodies or network errors.

API keys are encrypted using AES-256-GCM with authenticated field context and a random nonce per write. Keep `SETTINGS_ENCRYPTION_KEY` identical across API and worker replicas and back it up separately from PostgreSQL. Replacing it without re-encrypting settings makes saved secrets unreadable; provide credentials again to recover. No secrets belong in source control.

The native read client is isolated behind `ContentManager`. Event listing consumes all pages with `showAll=true`; incomplete, duplicated or inconsistent pages fail the entire read. Connection success validates read access, not download capability or compatibility of future write operations. Tests currently mock Sportarr; a real instance has not yet been exercised.

The native write adapter adds leagues without league-wide monitoring and leaves existing league preferences untouched. It creates or monitors explicit events, verifies their external and local league identities, and reconciles potentially committed writes before retrying. Search uses POST `/api/event/{id}/automatic-search`. The worker must pass the write compatibility gate (Sportarr 4.1.11 or a later 4.1 patch); later minor/major releases require review. These adapter operations are tested with mocks and connected to the fulfillment worker.

## Background reconciliation

The BullMQ worker publishes fulfillment outbox entries every minute using stable job IDs. A database acknowledgement follows queue insertion, so a crash can safely republish the same work. Every five-minute bucket also schedules reconciliation for approved, downloading and available requests; this recovers lost queue data and detects removed files. Failed jobs retry five times with backoff, honoring metadata Retry-After delays. Later periodic runs retry persistent failures. Notification outbox entries are published to the same queue and delivered independently of Sportarr synchronization.

A renewable shared lease serializes work against each configured Sportarr URL. The worker verifies the exact event or complete season metadata before writing. New seasons are discovered again over time; adding new events never enables other seasons or rewrites league preferences. Searches run only for already-started events without files or active queue work, with a shared six-hour throttle (five minutes after a failed search command).

`AVAILABLE` requires Sportarr's multipart-complete `hasFile` plus an existing imported file. Queue completion alone remains `DOWNLOADING` until import. A season additionally requires Hub to report it non-current, its end date to have passed, and every listed event to be completed or cancelled. An empty scope cannot become available. Conservative metadata can therefore delay availability; later metadata corrections can reopen a request. Failures preserve the approval state and expose a sanitized `lastError` code with `integrationState=error`.

Active event progress is persisted in `RequestEvent` and included in request detail responses. Run the transaction-backed worker test with:

```sh
docker compose run --rm --no-deps app node apps/server/test/integration/fulfillment.cjs
```

## Email and Discord notifications

GET/PUT `/api/v1/admin/settings/notifications` manages SMTP and Discord settings. GET `/api/v1/admin/settings/notifications/deliveries` lists the latest 100 delivery attempts for administrators. Both channels start disabled. SMTP passwords and Discord webhook URLs are encrypted with field-specific context; GET returns only presence flags. Omit a secret to retain it, or send an empty string to clear it. Changing SMTP connection details requires explicitly supplying the password again.

SMTP fields are `emailEnabled`, `smtpHost`, `smtpPort`, `smtpSecurity` (`tls`, `starttls`, or `plain`), `smtpUser`, optional `smtpPassword`, and `emailFrom`. Prefer TLS or mandatory STARTTLS; plain mode is for an explicitly configured local relay. Discord fields are `discordEnabled`, optional `discordWebhook`, and `discordLocale` (`en` or `es`). Only HTTPS Discord webhook URLs are accepted. Redirects are disabled and Discord mentions are suppressed.

Subscribers receive status emails in their profile language. Administrators also receive newly created request emails. Discord receives one channel-wide message in its configured language. Enabling a channel does not send historical notices. Text-only emails avoid HTML injection and use stable Message-ID values. SMTP has connection/greeting/socket timeouts and cannot load files or URLs from message content.

Each recipient/channel/outbox event has a unique delivery record. Successful deliveries are skipped on retry; failures record sanitized codes and retry through BullMQ. The latest attempts are visible to administrators. Delivery is at least once: a process crash after provider acceptance but before the database acknowledgement can cause a duplicate. SMTP/Discord do not provide a shared transactional boundary with Pedirr. Tests use mocked Discord and a local SMTP fixture; no external recipients are contacted during tests.

## Web interface

The Docker app serves the React SPA and API from the same origin. Open `http://localhost:3000` (or your configured `APP_PORT`). Direct routes such as `/requests/{id}` return the SPA; API paths retain JSON behavior. Fonts ship locally. English/Spanish selection is available before login, and authenticated profile timezone controls fixture times.

Implemented screens cover authentication, discovery, league/season/team/event detail, scoped requests, request tracking/moderation and profile/password changes. Administrators can also manage users and approval policies, test/configure Sportarr, and configure notifications and inspect delivery attempts.

For frontend development use `npm run dev:web`. Vite listens on port 5173 and proxies `/api` to localhost:3187. Configure the API's `APP_ORIGIN` to the exact frontend development origin to satisfy CSRF validation. Run `npm run test:browser` for fixture-backed browser flows; install Chromium with `npx playwright install chromium` or set `CHROMIUM_PATH`. CI installs Playwright's Chromium. Local browser tests default to `/usr/bin/chromium`.

## Availability before requesting

GET `/api/v1/requests/lookup?kind=event&identifier=...` (or `kind=season`) returns `requested` with the existing request ID/status, `available`, `missing`, or `unknown` with a reason. The detail screen links existing requests, offers subscription without duplication, and removes the request action for available content.

POST `/api/v1/requests` repeats the availability check. Already imported content returns `{created:false,available:true,request:null}` without creating database records or background work. If a configured manager cannot be checked, the API returns HTTP 503 `AVAILABILITY_UNKNOWN`; an outage is never treated as evidence that content is missing. An unconfigured installation may still collect requests for an administrator.

Availability inspection performs only GET requests. It matches exact Hub short IDs and local league IDs, checks complete manager pagination, and requires imported multipart-complete file state. A season must additionally be closed according to the same conservative metadata rules as worker reconciliation. The check is a point-in-time observation; a remote library can change immediately afterward.

## Full workflow integration test

After building the image, run `docker compose run --rm --no-deps app node apps/server/test/integration/worker.cjs`. This starts an isolated API and SMTP receiver, uses real PostgreSQL transactions and Redis/BullMQ jobs, and serves controlled Sportarr HTTP responses. It verifies login, CSRF, role checks, encrypted settings, request approval, event monitoring, downloading/imported states, localized email delivery, replay deduplication, and logout. The test creates and removes a unique database schema and Redis namespace; it does not alter application users/settings or send external messages. It validates Pedirr's integration behavior, not compatibility with a running Sportarr installation.
