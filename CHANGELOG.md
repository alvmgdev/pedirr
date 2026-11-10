# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the major version is 0, minor releases may include breaking changes.

## 0.1.1 - 2026-11-10

- `TRUST_PROXY` setting for deployments behind a reverse proxy. Rate limits for login, registration and writes now apply per client address taken from the trusted proxy's `X-Forwarded-For`, instead of to the proxy's single address. Disabled by default; trusting every peer is refused and invalid values stop startup.

## 0.1.0 - 2026-11-10

First public release, licensed under GPL-3.0-or-later.

- Email and password accounts with revocable sessions, CSRF and Origin protection, an initial administrator command, administrator user management, and self-registration that is closed by default.
- Sportarr Hub catalog: search, leagues, seasons, teams, events and a seven-day upcoming schedule.
- Season and event requests with deduplication, shared subscriptions, availability checks against Sportarr, and manual or automatic approval by role and by user.
- Background fulfillment against Sportarr 4.1.11 and later 4.1 releases that monitors requested events without changing existing league settings, triggers searches and tracks availability.
- Email (SMTP) and Discord notifications with localized messages, delivery history and retries.
- English and Spanish interface.
- Docker Compose deployment from a multi-architecture image (linux/amd64, linux/arm64).
