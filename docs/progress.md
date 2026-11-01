# Implementation status

## Delivered

- Upstream research and architecture decisions recorded.
- Node workspace, NestJS API, OpenAPI, PostgreSQL schema, Redis worker foundation, Docker Compose.

## Remaining MVP work

1. Authentication, CSRF, distributed rate limiting, roles, and user administration.
2. Sportarr Hub adapter, cache, multilingual discovery interface, league/season/event details.
3. Transactional request workflow, subscriptions, deduplication, moderation and auto-approval policies.
4. Encrypted settings, Sportarr connection test, safe season/event fulfillment, version checks.
5. Transactional outbox publication, recurring reconciliation, retries, progress and availability.
6. SMTP and Discord delivery with localized templates.
7. Request and client mock tests, database concurrency tests, browser flows, accessible visual review, deployment validation.

A passing foundation build is not proof that the MVP is complete. The goal remains active until every requirement is implemented and verified.
