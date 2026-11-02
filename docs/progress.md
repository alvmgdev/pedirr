# Implementation status

## Delivered

- Upstream research and architecture decisions recorded.
- Node workspace, NestJS API, OpenAPI, PostgreSQL schema and initial migration, Redis worker foundation, Docker Compose.
- Argon2id authentication, revocable sessions, session-bound CSRF tokens and Origin validation, distributed login/write rate limits, profile and password endpoints, protected administrator bootstrap.
- Fifty-three tests cover authentication, administration, policy precedence, metadata contracts, shared cache/cooldown, pagination and upcoming event filtering.
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

## Remaining MVP work

1. Review remaining failure/recovery paths after the passing HTTP-to-SMTP workflow test. Real Sportarr validation is still unavailable without a real instance.
2. Review compatibility, failure/recovery behavior, pagination, scoped monitoring and development commands against the full requirements.
3. Complete deployment checks and requirement-by-requirement completion audit.


A passing foundation build is not proof that the MVP is complete. The goal remains active until every requirement is implemented and verified.
