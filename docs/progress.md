# Implementation status

## Delivered

- Upstream research and architecture decisions recorded.
- Node workspace, NestJS API, OpenAPI, PostgreSQL schema and initial migration, Redis worker foundation, Docker Compose.
- Argon2id authentication, revocable sessions, session-bound CSRF tokens and Origin validation, distributed login/write rate limits, profile and password endpoints, protected administrator bootstrap.
- Twenty tests cover authentication, administration, policy precedence, metadata contracts, shared cache/cooldown, pagination and upcoming event filtering.
- PostgreSQL integration test verifies concurrent administrator changes in an isolated schema and session revocation.
- Administrator user creation, paginated listing, role/active status changes, registration and auto-approval policies, last-administrator protection and session revocation.
- Verified foundation container readiness against PostgreSQL, Redis, and worker heartbeat.
- npm dependency audit reports zero known vulnerabilities after dependency overrides and lockfile fixes.

- Sportarr Hub metadata adapter behind an interface; authenticated search, leagues, seasons, teams, events, upcoming and local popularity endpoints. Shared Redis cache, outbound budget and Retry-After cooldown.

- Live Hub reads validated search, league, season and event responses. Docker HTTP smoke test authenticated a temporary user, searched live metadata through Redis, rejected an invalid calendar date, and removed the temporary user.

- Request API with exact season/event scopes, canonical identity deduplication, subscriptions, paginated shared/personal lists, history, optimistic moderation, auto-approval and transactional outbox insertion.

- PostgreSQL request integration test passed concurrent deduplication, competing moderation, auto-approval precedence and outbox-failure rollback. CI now includes database integration tests.

## Remaining MVP work

1. Authentication and administrator UI.
2. Multilingual discovery interface and league/season/event detail views.
3. Request/moderation UI and reconciliation of already available manager content.
4. Encrypted settings, Sportarr connection test, safe season/event fulfillment, version checks.
5. Transactional outbox publication, recurring reconciliation, retries, progress and availability.
6. SMTP and Discord delivery with localized templates.
7. Request and client mock tests, database concurrency tests, browser flows, accessible visual review, deployment validation.

A passing foundation build is not proof that the MVP is complete. The goal remains active until every requirement is implemented and verified.
