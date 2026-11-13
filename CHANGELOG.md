# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the major version is 0, minor releases may include breaking changes.

## Unreleased

- Wrong downloads for team sports and newly announced events. Pedirr created requested events in Sportarr by hand, without team names or the local air date, and Sportarr then accepted releases of other games (an NBA request downloaded another game of the night before) or searched with the wrong date. Sportarr now imports the events from its catalog itself and Pedirr only monitors them; while an event is being imported the request says so and nothing is searched. Events created by earlier versions that still have no file should be deleted in Sportarr once, so they are imported again complete.
- An event nobody monitored yet gets exactly the requested parts when Pedirr starts monitoring it, also when Sportarr had imported it beforehand.

## 1.0.1 - 2026-11-13

- Parts are offered only when Sportarr knows them: for events it already holds, with their real parts (a Fight Night has no Early Prelims, weekly wrestling has none), and for seasons of leagues it holds. Before, an event Sportarr did not hold yet offered generic fight-card parts, even for wrestling. Such events are now requested whole.
- A request page offers "Follow this request" (or "Request parts" for a request with parts) to people who do not follow it yet; before, they had to find the event in the catalog.
- "Report a problem" and "Follow this request" sit at the top right of a request page, with the request's other actions; reporting opens a dialog, and your issues about the request are listed below it.
- Request pages say "1 subscriber" instead of "1 subscribers".
- The catalog says "You follow this request." instead of offering to follow a request the user already follows.
- The README opens with screenshots, a features list and a quick start.

## 1.0.0 - 2026-11-13

First stable release.

**Upgrading from 0.x:** back up PostgreSQL first (`docker compose exec -T postgres pg_dump -U pedirr pedirr > pedirr-backup.sql`) and keep `SETTINGS_ENCRYPTION_KEY`. Two database migrations (event parts and issues) run automatically before the API and worker start. Existing requests keep working as whole-event requests. Non-administrator users can no longer request whole seasons until an administrator allows it in their account. Nothing needs to change in `.env` or `compose.yaml`.

- Season access per user. Users request single events by default and an administrator can allow whole seasons when creating or editing the account; administrators can always request seasons. **Existing users lose season access until an administrator grants it.** The server rejects season requests without the permission (`SEASON_REQUESTS_NOT_ALLOWED`), and the season page explains the limitation instead of offering the request.
- Event parts. Requesting a fight card (or a season of them) opens a dialog to choose its parts, such as Early Prelims, Prelims and Main Card. The parts Sportarr monitors for the league come pre-selected, optional parts such as the Post Show do not, and each part shows whether it is already requested, downloading or in the library, without revealing who asked for it. Each user sees their own status for the parts they asked for, so another user's extra parts never move it backwards. New parts from a user without automatic approval wait for review, for that user only; a rejected part asked for again returns to review. Pedirr only adds the approved parts to Sportarr's monitoring, searches each of them separately, and never changes a "Full Event" event. Requests created earlier keep working as whole-event requests. Includes a database migration.
- The Pedirr mark on the sign-in screen and in the navigation sits on the wordmark's baseline at its ascender height instead of about 4 px too high, and scales with the wordmark on phones.
- Issues. Users report problems about content they follow (wrong content, missing content or part, quality, language, playback or other), optionally naming the affected event and part. Each issue is private to its reporter and the administrators, has a conversation with comments and status changes, and moves through open, in progress, resolved and closed; resolving requires an explanation, and reporters can close or reopen their own issues. A new Issues section lists them with a count of those awaiting attention, and administrators are notified of new issues. Includes a database migration.
- On phones the navigation shows "Admin" instead of "Administration" so five sections fit.
- A requested Post Show no longer keeps an event from becoming available: like Sportarr, Pedirr treats it as optional when other parts were requested. It is still monitored and searched, but only for seven days after the event; requested on its own, it is what that user waits for, without holding back anyone else.
- Administrators see who requested each request, with each person's parts and own status, under "Requested by" on the request details. Users still never see other subscribers.
- Requests for the whole event, including those made before parts existed, offer "Follow request" again instead of a parts dialog whose choice changed nothing, since they already cover every part.
- Node.js 24 LTS. The image, CI and development now use Node 24 (`engines` and `.nvmrc` pin it); Node 22 reaches end of life in April 2027. Nothing changes for Docker installations.
- `npm run dev:api` and `npm run dev:worker` start again on current Node releases, whose built-in TypeScript type stripping had broken them.

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
