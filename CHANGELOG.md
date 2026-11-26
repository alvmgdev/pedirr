# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the major version is 0, minor releases may include breaking changes.

## Unreleased

- Resellers and packages in Administration. The platform administrator creates packages (named sets of plans, which several resellers can share) and resellers: a name, an address code (generated when left empty, fixed afterwards), a package, an optional client limit and the reseller administrator's account. The reseller page shows the address to hand out with a copy button, lets you rename, disable (which signs its users out) or change its package and limit, and sets a new password for its administrator. Packages and plans that resellers rely on cannot be deleted. The Users tab lists every account with its environment (the platform or a reseller) and can be filtered by environment; a reseller's accounts keep their role, and its clients can only be given plans of the reseller's package.
- Resellers have their own address: `https://your-domain/<code>/`. The sign-in page there shows the reseller's name and signs in to that reseller's accounts only, so the same email can belong to several resellers with different passwords. Each reseller keeps its own session cookie under its path, so a browser can be signed in to the platform and to resellers at once without mixing them. An unknown address says it does not exist, and a disabled reseller says it is not available and signs everyone out. The platform stays at the root, unchanged. Accounts at a reseller are created by its administrator; self-registration remains a platform option.
- Groundwork for resellers. Every account now belongs to an environment: the platform, reached at the root of the domain, or a reseller (coming next). Existing accounts move to the platform, so current administrators become platform administrators and nothing changes for them. Emails are unique per environment, so the same person can later have an account with several resellers. A reseller administrator role and plan packages (sets of plans the platform gives a reseller) are added for the next steps.
- Optional weekly request limit per user. Administrators switch it on in the user form and set how many new requests the user may start in any seven days; switched off, the user has no limit. Only starting a request counts: following a request someone else made is free, and a rejected request is given back. Users see how many requests they have left on the request button and in their account, and when the next one frees up. Administrators are never limited. Requests started before this version count from the moment a limit is set.
- Optional expiration date per user, switched on the same way. When that day ends the user is signed out and cannot sign in again (they are told the account expired); their requests keep going, and extending or removing the date brings the account back. The user list shows expired accounts, and users see the date in their account. Administrators never expire.
- Only administrators request whole seasons. A season keeps growing into new events until it ends and can mean hundreds of downloads, which no per-user limit handles fairly, so users request the events they want one by one. The "Can request whole seasons" permission is removed from the user form and the API (`canRequestSeasons`); the role field explains it instead. Season pages stay available to browse. Season requests users made before keep being fulfilled until they finish.
- Plans: content packages. Administrators create plans in Administration → Plans with every sport and league, or a chosen set of sports (each with all its leagues, including future ones) and single leagues found in the catalog, and assign one to each user. A user on a plan can only request, and follow, content of the plan's leagues; elsewhere the request button is replaced by "Your plan does not include this league." Weekly limits stay on each user. Users without a plan can still request everything, and administrators are never restricted. A plan with users cannot be deleted. Users see their plan in their account.
- The catalog follows the user's plan. Users on a plan see only its leagues in search and in the league list, team pages and the upcoming schedule show only events of those leagues, and opening a league, season or event outside the plan says "Your plan does not include this league." Hub's search does not say which sport a league belongs to, so Pedirr keeps a daily index of Hub's leagues. Administrators and users without a plan see the whole catalog as before.
- Local copy of the schedule. The worker copies Hub's events from 7 days ago to 14 days ahead once a day, and today's and tomorrow's every hour, in the background (at most a third of the Hub budget, one call every 10 seconds by default). "Upcoming" is served from it for everyone, so it pages properly and no longer calls Hub on every visit; for users on a plan every page is full of the plan's events. Users on a plan also find, in search, the events of their leagues in that window and the teams playing them. Until the first complete copy exists, or if it is more than two days old, Hub answers as before.

## 1.1.0 - 2026-11-13

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
