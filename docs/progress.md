# Implementation status

## Delivered

- Upstream research and architecture decisions recorded.
- Node workspace, NestJS API, OpenAPI, PostgreSQL schema and initial migration, Redis worker foundation, Docker Compose.
- Argon2id authentication, revocable sessions, session-bound CSRF tokens and Origin validation, distributed login/write rate limits, profile and password endpoints, protected administrator bootstrap.
- Forty-five tests cover authentication, administration, policy precedence, metadata contracts, shared cache/cooldown, pagination and upcoming event filtering.
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

- React/Vite bilingual SPA with login/registration, locale/timezone profile, schedule-led discovery, league/season/team/event details, request creation, request lists, moderation and history. Two browser flows passed on desktop/mobile fixtures; screenshots reviewed. Administration/settings screens remain pending.

- Real Docker browser smoke passed login/CSRF profile update, authenticated direct-route reload and logout with no JavaScript errors; the temporary test user was removed.

## Remaining MVP work

1. Administrator user/policy/settings UI.
2. Catalog availability checks before requesting and remaining discovery refinements.
3. Reconciliation of already available manager content before creating a new request.
4. Sportarr settings UI, safe season/event fulfillment, compatibility checks and real-instance validation.
5. Broader worker failure/recovery and real Sportarr end-to-end validation.
6. Notification settings UI and final notification flow validation.
7. Request and client mock tests, database concurrency tests, browser flows, accessible visual review, deployment validation.

A passing foundation build is not proof that the MVP is complete. The goal remains active until every requirement is implemented and verified.
