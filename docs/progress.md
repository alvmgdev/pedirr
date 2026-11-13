# Implementation status

## Delivered

- Upstream research and architecture decisions recorded.
- Node workspace, NestJS API, OpenAPI, PostgreSQL schema and initial migration, Redis worker foundation, Docker Compose.
- Argon2id authentication, revocable sessions, session-bound CSRF tokens and Origin validation, distributed login/write rate limits, profile and password endpoints, protected administrator bootstrap.
- Server unit tests cover authentication, administration, policy precedence, metadata contracts, shared cache/cooldown, pagination and upcoming event filtering.
- PostgreSQL integration test verifies concurrent administrator changes in an isolated schema and session revocation.
- Administrator user creation, paginated listing, role/active status changes, registration and auto-approval policies, last-administrator protection and session revocation.
- Verified foundation container readiness against PostgreSQL, Redis, and worker heartbeat.
- npm dependency audit reports zero known vulnerabilities after dependency overrides and lockfile fixes.

- Sportarr Hub metadata adapter behind an interface; authenticated search, leagues, seasons, teams, events, upcoming and local popularity endpoints. Shared Redis cache, outbound budget and Retry-After cooldown.

- Live Hub reads validated search, league, season and event responses. Docker HTTP smoke test authenticated a temporary user, searched live metadata through Redis, rejected an invalid calendar date, and removed the temporary user.

- Request API with exact season/event scopes, canonical identity deduplication, subscriptions, paginated shared/personal lists, history, optimistic moderation, auto-approval and transactional outbox insertion.

- PostgreSQL request integration test passed concurrent deduplication, competing moderation, auto-approval precedence and outbox-failure rollback. CI now includes database integration tests.

- Encrypted Sportarr settings and authenticated connection testing; native read client behind ContentManager preserves URL bases and validates complete event pagination. Mock tests cover credentials, redaction, application identity, pagination and authenticated encryption.

- Native write client supports inert league creation, explicit event monitoring, separate search commands and queue normalization, with reconciliation after ambiguous writes and strict identity checks. Source-based write compatibility gate covers Sportarr 4.1.11 and later 4.1 patches. Worker integration is implemented and transaction-tested.

- BullMQ dispatcher publishes fulfillment outbox records, schedules recurring reconciliation and retries failures. Worker persists scoped event progress, checks imported multipart state, handles removed files and throttles searches under a shared renewable manager lease. Notification outbox records are delivered by the worker.

- Docker migration applied successfully; live BullMQ dispatcher completed jobs with zero failures and API readiness returned 200.

- SMTP and Discord settings, encrypted credentials, localized text templates, per-recipient delivery records and retries. Tests cover successful-delivery deduplication, Retry-After, mention suppression, historical-event exclusion and delivery to a local SMTP fixture.

- React/Vite bilingual SPA with login/registration, locale/timezone profile, schedule-led discovery, league/season/team/event details, request creation, request lists, moderation and history. Two browser flows passed on desktop/mobile fixtures; screenshots reviewed. Administrator screens now cover users, role policies, Sportarr connection/defaults and notification settings/deliveries.

- Real Docker browser smoke passed login/CSRF profile update, authenticated direct-route reload and logout with no JavaScript errors; the temporary test user was removed.

- Browser administration tests cover connection testing, default selection, secret retention, role-based UI access, approval policies and last-administrator errors.

- Pre-request availability lookup recognizes existing requests and exact imported Sportarr content without writes. Submission rechecks availability and refuses uncertain configured-manager results. The UI shows availability or links/follows the existing request. Seven browser tests pass.

- Real PostgreSQL/Redis worker integration verifies request creation and moderation through services, BullMQ dispatch, native Sportarr HTTP fixture writes, downloading/imported state changes, localized notification capture, replay deduplication and preservation of existing league monitoring. CI runs this test with isolated database and queue namespaces. The extended test now exercises the production Nest module through HTTP: login, CSRF rejection, input validation, role enforcement, encrypted settings, request creation and approval, status reads, logout/session revocation, and real local SMTP delivery. Only upstream metadata and Sportarr are fixtures; no external mail is sent.

- Development API and worker now use TypeScript decorator metadata through `ts-node` and Node watch mode. An isolated Docker development API smoke passed CSRF generation and unauthenticated-route rejection; the public instance was not restarted.

- Notification outbox records now distinguish publication from successful processing. The dispatcher recovers lost/exhausted jobs after 15 minutes while preserving live/delayed retries. The real HTTP-to-SMTP integration test passes lost-job recovery, transient SMTP failure recovery, delayed-job preservation and confirmed-delivery deduplication. Migration `202611020002_outbox_processing` adds processing timestamps and queue identifiers.

- OpenAPI now includes success response contracts for every route, cookie/CSRF/Origin authentication requirements, administrator permissions and error conventions. The HTTP integration test compiles every success schema and checks actual workflow responses against the specification.

- Accessibility review covers login, discovery, event details, requests, moderation, account and all administration tabs. Axe checks WCAG 2 A/AA, WCAG 2.1 AA and best-practice rules in English desktop and Spanish mobile fixtures. Navigation landmarks and heading order were corrected; keyboard skip-to-content and horizontal overflow checks pass. This is automated coverage plus a focused keyboard check, not a claim of complete assistive-technology certification.

## MVP acceptance

Implementation and required verification are complete; see [the requirement-by-requirement review](mvp-acceptance.md). Final checks passed: 54 server tests, four integration programs, nine browser tests, type checking, production builds and dependency audit (zero known vulnerabilities). The deployed API, PostgreSQL, Redis and worker report healthy readiness.

A complete season is covered through HTTP approval, BullMQ and the native Sportarr HTTP adapter: all metadata pages are read, cancelled/inactive events are excluded, open seasons remain incomplete, closed imported seasons become available, and cross-season metadata is rejected before remote writes. Existing monitoring settings remain intact.

Known validation limits at MVP time: no real Sportarr installation or external email/Discord destination had been exercised. Since then Pedirr has run against a real Sportarr 4.1.11 installation (see [live validation](api-research.md#live-validation)); external email/Discord delivery is still unexercised. Native writes remain gated to the source-reviewed Sportarr 4.1 release line starting at 4.1.11. Upstream metadata quotas, update cadence and broadcast completeness are not guaranteed. No production-load benchmark or full manual accessibility certification is claimed.

## Maintenance

- 2026-11-09: Source is formatted with Prettier (`npm run format`, checked in CI with `npm run format:check`); the reformat commit is listed in `.git-blame-ignore-revs`. The app header is one banner landmark, and the web client reuses the session-bound CSRF token across writes, refreshing it once on `CSRF_INVALID`. Verified with 57 server tests, 16 browser tests, type checks and production builds; the PostgreSQL integration programs were not rerun for this formatting-only change.
- 2026-11-09: ESLint (`npm run lint`) runs in CI with the recommended JavaScript and typescript-eslint rules, React hooks rules, `eqeqeq` and `curly`. The brace autofix commit is also listed in `.git-blame-ignore-revs`.
- 2026-11-09: The sign-in screen offers account creation only while registration is enabled, using the public GET `/api/v1/auth/config`. If registration closes while the form is open, the server refusal is shown and the option disappears.
- 2026-11-10: Release packaging. The runtime image keeps only production dependencies and compiled output (557 MB, down from 726 MB; Prisma's client, CLI and engines account for most of the rest), builds natively for linux/amd64 and linux/arm64, and runs migrations with the bundled Prisma CLI. `compose.yaml` pulls the published image and `compose.build.yaml` builds it locally. CI builds the image on every push; the tag-triggered Release workflow reruns CI and pushes to Docker Hub. Verified locally: amd64 Compose stack healthy (migrations, API, worker, web, API docs) and arm64 image loads argon2 and the arm64 Prisma engines.
- 2026-11-13: Per-user season access (`User.canRequestSeasons`, default false for existing and new users; administrators always allowed). Enforced before metadata lookups and again inside the request transaction against the stored user. Administrators set it on creation and in the user editor; the season page explains the limitation. Verified with unit tests, the request and fulfillment PostgreSQL integration programs, and browser tests.
- 2026-11-13: Event parts. `RequestPart` holds each requested part with a shared review status; `RequestSubscriber` keeps each user's parts and own status; `RequestEvent` records each event's parts, parts on disk and parts downloading (migration `202611130002_request_parts`). GET `/requests/parts` offers Sportarr's part definitions with its defaults and each part's state; creation, joining, re-review of rejected parts and moderation of pending parts follow the agreed per-user model. The worker only adds approved parts to Sportarr's monitoring, searches each missing part separately and never changes a "Full Event" event. Sportarr endpoints were checked against the 4.1.11 source; no live Sportarr was used. Verified with unit tests, a new PostgreSQL integration program (`parts.cjs`), the existing integration programs (whole-event behaviour unchanged), browser tests including an axe check of the dialog, and desktop/mobile screenshots.
- 2026-11-13: The brand mark on the sign-in screen and navigation sat 4-5 px above the wordmark's optical center because it was centered on the line box, which includes descender space. It now uses baseline alignment and a 0.74em height (the ascender height), scaling with the wordmark on phones. A browser test measures both edges on desktop and mobile and fails on the previous styles.
- 2026-11-13: Issues. `Issue` and `IssueComment` (migration `202611140001_issues`) let subscribers report problems on a request, optionally an event and part, private to the reporter and administrators. Administrators manage the lifecycle; reporters close or reopen their own issues; resolving requires a comment. New issues notify administrators; comments and status changes notify the other side through the existing outbox. Verified with unit tests (lifecycle rules, validation, notification recipients), a new PostgreSQL integration program (`issues.cjs`), the existing integration programs, browser tests on desktop and in Spanish on a phone, and the accessibility suite on the issue screens.
- 2026-11-13: Optional Post Show. A requested Post Show no longer blocks availability when other parts were requested (per user and per request), mirroring Sportarr; it is monitored and searched until seven days after the event start. Requested on its own it still decides that user's availability. Verified with unit tests and the parts integration program (recent and old events, a Post Show-only subscriber alongside others).
- 2026-11-13: Request details list every subscriber's email, parts and own status for administrators only ("Requested by"), so they can tell who asked for what; users still see only their own subscription. Verified in the parts integration program and browser tests.
- 2026-11-13: Node.js 24. The image (`node:24-bookworm-slim`), CI, `@types/node`, `engines` and `.nvmrc` move to Node 24 ahead of Node 22's April 2027 end of life. Verified on Node 24 with a clean `npm ci`, type checks, builds, 88 unit tests, all six integration programs, 30 browser tests, the audit, amd64 and arm64 images (argon2 and Prisma engines load natively) and a healthy Compose stack. The development entry points had already stopped starting on Node 22.18+ because native type stripping loads a `.ts` entry as an ES module; `apps/server/dev.cjs` now registers `ts-node` first, verified on Node 22 and 24 including watch restarts.
