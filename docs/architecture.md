# Architecture

React/TypeScript SPA; NestJS REST API with OpenAPI; PostgreSQL/Prisma migrations; BullMQ/Redis background jobs. One modular application with separately scalable API and worker processes. Sessions, rate limits, caches, and durable work live outside application memory.

Browser -> API -> domain services -> database and transactional outbox -> worker -> Sportarr / SMTP / Discord. Metadata discovery uses an isolated MetadataProvider; fulfillment uses ContentManager; delivery uses NotificationChannel.

A league request targets one selected season. Event requests target one event. The unique target and scope prevent duplicate requests; subscribers share fulfillment. Approval and outbox insertion must commit atomically. Jobs reconcile before retrying ambiguous remote writes. Approval failures remain approved with an independent integration error.

Visible states: pending, approved, rejected, downloading, available. Season requests aggregate their scoped events. Open seasons cannot be complete merely because all currently aired games have files. Preserve manually managed Sportarr configuration and explicit event monitoring.

Security implementation requirements: Argon2id passwords, opaque revocable sessions, CSRF tokens and Origin validation, same-origin deployment, server authorization, shared rate limiting, encrypted settings secrets with an external key, strict input validation, and redacted structured logs. UI and notifications support en/es; timestamps are stored in UTC. All source and documentation are English.

Deployment consists of app, worker, PostgreSQL, Redis, and a single migration task. Implemented modules: auth/users, catalog/discovery, requests/moderation, settings/integrations, synchronization, notifications.
