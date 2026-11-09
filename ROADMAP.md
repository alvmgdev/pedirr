# Roadmap

Checked items are implemented; unchecked items are planned for the future and have no committed date.

## Accounts and access

- [x] Email and password sign-in with Argon2id, revocable sessions and CSRF/Origin protection
- [x] Initial administrator bootstrap command
- [x] Administrator user management: creation, roles, active status and per-user auto-approval
- [x] Self-registration, closed by default and enabled or disabled by administrators
- [x] Profile language and timezone; password changes revoke existing sessions

## Discovery

- [x] Sportarr Hub catalog: search, leagues, seasons, teams and events
- [x] Seven-day upcoming schedule with incremental loading
- [x] Popular leagues ranked by requests in this installation

## Requests

- [x] Season and event requests with deduplication and shared subscriptions
- [x] Availability check against Sportarr before requesting
- [x] Manual review and automatic approval policies by role and by user
- [x] Request tracking (pending, approved, rejected, downloading, available) with history

## Sportarr integration

- [x] Encrypted connection settings, connection test, library folder and quality profile defaults
- [x] Background fulfillment that monitors requested events without changing existing league settings, triggers searches and tracks progress and availability (Sportarr 4.1.11 and later 4.1 releases)

## Notifications

- [x] Email over SMTP
- [x] Discord webhooks
- [x] Localized messages, delivery history and automatic retries
- [ ] Additional notification providers. Delivery is isolated behind the `NotificationChannel` interface (`apps/server/src/notifications/channels.ts`); a new provider needs its own channel implementation, encrypted settings and administrator configuration, and reuses the existing outbox, per-recipient delivery records and retry handling.

## Interface

- [x] English and Spanish user interface
- [x] Responsive dark catalog with automated accessibility checks

## Platform

- [x] Docker Compose deployment with separate API and worker processes
- [x] OpenAPI documentation
- [x] Continuous integration: formatting, linting, type checks, unit, integration and browser tests, dependency audit
