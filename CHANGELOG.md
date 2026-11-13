# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the major version is 0, minor releases may include breaking changes.

## Unreleased

- Season access per user. Users request single events by default and an administrator can allow whole seasons when creating or editing the account; administrators can always request seasons. **Existing users lose season access until an administrator grants it.** The server rejects season requests without the permission (`SEASON_REQUESTS_NOT_ALLOWED`), and the season page explains the limitation instead of offering the request.
- Event parts. Requesting a fight card (or a season of them) opens a dialog to choose its parts, such as Early Prelims, Prelims and Main Card. The parts Sportarr monitors for the league come pre-selected, optional parts such as the Post Show do not, and each part shows whether it is already requested, downloading or in the library, without revealing who asked for it. Each user sees their own status for the parts they asked for, so another user's extra parts never move it backwards. New parts from a user without automatic approval wait for review, for that user only; a rejected part asked for again returns to review. Pedirr only adds the approved parts to Sportarr's monitoring, searches each of them separately, and never changes a "Full Event" event. Requests created earlier keep working as whole-event requests. Includes a database migration.
- The Pedirr mark on the sign-in screen and in the navigation sits on the wordmark's baseline at its ascender height instead of about 4 px too high, and scales with the wordmark on phones.

## 0.2.0 - 2026-11-10

- Events split into parts (Early Prelims, Prelims, Main Card…) are now completed automatically: once an event holds some part files, every monitored missing part gets its own automatic search in the same run, instead of an event-level search that kept choosing the part already held. Parts already downloading, the optional Post Show and unmonitored parts are skipped; a whole-event file still covers every part.
- Configurable search retry interval, `SEARCH_RETRY_MINUTES`. **The default changes from 6 hours to 60 minutes**; set `SEARCH_RETRY_MINUTES=360` to keep the previous behaviour. Each event and each part has its own interval.

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
