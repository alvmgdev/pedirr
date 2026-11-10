# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the major version is 0, minor releases may include breaking changes.

## 0.1.0 - Unreleased

First public release.

- Email and password accounts with revocable sessions, CSRF and Origin protection, an initial administrator command, administrator user management, and self-registration that is closed by default.
- Sportarr Hub catalog: search, leagues, seasons, teams, events and a seven-day upcoming schedule.
- Season and event requests with deduplication, shared subscriptions, availability checks against Sportarr, and manual or automatic approval by role and by user.
- Background fulfillment against Sportarr 4.1.11 and later 4.1 releases that monitors requested events without changing existing league settings, triggers searches and tracks availability.
- Email (SMTP) and Discord notifications with localized messages, delivery history and retries.
- English and Spanish interface.
- Docker Compose deployment from a multi-architecture image (linux/amd64, linux/arm64).
