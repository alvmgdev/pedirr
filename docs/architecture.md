# Architecture

React/TypeScript SPA; NestJS REST API with OpenAPI; PostgreSQL/Prisma migrations; BullMQ/Redis background jobs. One modular application with separately scalable API and worker processes. Sessions, rate limits, caches, and durable work live outside application memory.

Browser -> API -> domain services -> database and transactional outbox -> worker -> Sportarr / SMTP / Discord. Metadata discovery uses an isolated MetadataProvider; fulfillment uses ContentManager; delivery uses NotificationChannel.

A league request targets one selected season. Event requests target one event. The unique target and scope prevent duplicate requests; subscribers share fulfillment. Approval and outbox insertion must commit atomically. Jobs reconcile before retrying ambiguous remote writes. Approval failures remain approved with an independent integration error.

Visible states: pending, approved, rejected, downloading, available. Season requests aggregate their scoped events. Events split into parts are requested by part: each requested part has one shared review status, and each subscriber has their own status derived only from the parts they asked for, so one user's extra parts never move another user's status backwards. Pedirr only ever adds parts to Sportarr's monitoring. Open seasons cannot be complete merely because all currently aired games have files. Preserve manually managed Sportarr configuration and explicit event monitoring.

Security implementation requirements: Argon2id passwords, opaque revocable sessions, CSRF tokens and Origin validation, same-origin deployment, server authorization, shared rate limiting, encrypted settings secrets with an external key, strict input validation, and redacted structured logs. UI and notifications support en/es; timestamps are stored in UTC. All source and documentation are English.

Deployment consists of app, worker, PostgreSQL, Redis, and a single migration task. Implemented modules: auth/users, catalog/discovery, requests/moderation, issues, settings/integrations, synchronization, notifications.

## Data model

| Model                              | Responsibility and relationships                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User / Session                     | Roles, approval overrides, season access (single events by default), locale/timezone; revocable hashed session tokens belong to users.                                       |
| CatalogEntity / ExternalIdentifier | Cached entity metadata and unique provider/namespace/value identities.                                                                                                       |
| Request / RequestSubscriber        | A unique entity/scope request shared by interested users. A league request has an explicit season scope. Subscribers keep their own parts and status.                        |
| Issue / IssueComment               | Problems reported by subscribers about a request (optionally an event and part), private to the reporter and administrators, with a timeline of comments and status changes. |
| RequestPart                        | One requested event part (e.g. Main Card) with its shared review status; none means the whole event.                                                                         |
| RequestHistory / RequestEvent      | Moderation/status history and the exact scoped events reconciled with Sportarr, with each event's parts on disk and downloading.                                             |
| Setting                            | Shared policies and encrypted integration credentials.                                                                                                                       |
| OutboxEvent                        | Transactional work intent, queue publication and successful notification processing.                                                                                         |
| NotificationDelivery               | Unique event/channel/recipient delivery attempts and confirmation.                                                                                                           |
| ManagerBinding                     | Reserved manager/entity identity mapping for future adapters; native fulfillment currently records remote event IDs in RequestEvent.                                         |

The authoritative constraints, relations and indexes are in `prisma/schema.prisma`. Versioned migrations create these structures before application startup.

## Source layout

- `apps/server/src/auth.ts`, `users.ts`: sessions, authorization and user/policy services.
- `apps/server/src/metadata`: provider interface, Hub client and discovery routes.
- `apps/server/src/requests`: scoped request workflow and existing-content availability.
- `apps/server/src/managers`: isolated manager interface and native Sportarr adapter.
- `apps/server/src/settings`: encrypted configuration and connection tests.
- `apps/server/src/jobs`, `notifications`, `worker.ts`: outbox dispatch, reconciliation and delivery.
- `apps/server/src/openapi.ts`: explicit response contracts supplementing controller request DTOs.
- `apps/web/src`: bilingual React pages, reusable UI, API access and styles.
- `prisma/migrations`: ordered relational schema changes.
- `apps/server/test`, `tests/browser`: service, integration and browser checks.

## Implementation phases and review units

| Phase | Deliverable                                                                       |
| ----- | --------------------------------------------------------------------------------- |
| 0     | Upstream contract research, provider choice, uncertainty and scope documentation. |
| 1     | Database migrations, deployment, authentication and user administration.          |
| 2     | Discovery and canonical season/event request workflow.                            |
| 3     | Encrypted Sportarr settings, native adapter and background reconciliation.        |
| 4     | Localized email/Discord notifications and durable recovery.                       |
| 5     | Bilingual schedule-led frontend and administrator controls.                       |
| 6     | HTTP-to-SMTP integration, OpenAPI contracts, accessibility and acceptance audit.  |

Small functional commits retain these review boundaries; `git log --oneline` records the actual implementation history. The endpoint inventory and request/response schemas are served at `/api/docs` and `/api/openapi.json`; README describes installation and the principal workflows.
