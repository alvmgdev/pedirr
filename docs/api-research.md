# Upstream API research

Investigated before implementation on 2026-11-01. Sportarr source reference: `f3a6b02c927b11ca3893660fa6d1d6176f2df26a`. This research used the source only; live validation came later and is recorded below.

## Sources

- https://github.com/Sportarr/Sportarr
- https://wiki.sportarr.net/development/integration-api/
- https://sportarr.net/openapi-partner.json
- https://www.thesportsdb.com/documentation

## Metadata

Use Sportarr Hub behind MetadataProvider. Public routes include GET `/api/public/v1/search` (q, types, limit), `/leagues`, `/leagues/{identifier}`, `/leagues/{identifier}/seasons`, `/leagues/{identifier}/teams`, `/teams/{identifier}`, `/seasons/{identifier}`, `/events`, and `/events/{identifier}` under the same prefix. Events accept league, season, team, from, to, page, page_size. Public paginated responses use items, total, page, pageSize, totalPages. Preserve UUIDs, shortId, and optional tsdbId separately. Never derive Hub IDs arithmetically from TheSportsDB IDs.

GET https://sportarr.net/api/rate-limit reported search=300/minute, metadata=300/minute, public=20/minute, livescore=1200/minute. A normal compatibility search decremented search; public/v1 search and league reads did not decrement these counters in the sampled requests. The shipped frontend also contains different generic limits. Therefore the precise policy for public/v1 remains unconfirmed. Do not interpret absent accounting as unlimited service. Cache and throttle requests, honor Retry-After, and retry 429 with backoff. Source ingestion cadence and complete broadcast coverage are not verified.

TheSportsDB v1 has explicit endpoint-specific free restrictions and 30 requests/minute. It is not an automatic fallback: cross-provider identity must be resolved first. Hub is the initial provider; direct TheSportsDB support remains an extension point.

## Local Sportarr

Authenticate with X-Api-Key, respecting the configured URL base. GET `/api/system/status` identifies the application; GET `/api/leagues` validates credentials. Settings use GET `/api/rootfolder` and `/api/qualityprofile`.

POST `/api/leagues` accepts externalId, name, sport, monitored, monitorType, rootFolderId, qualityProfileId, monitoredTeamIds. Team sports without selected teams may be created unmonitored. Root folder setup is mandatory. Responses can be 201 with a league or 200 with leagueId and monitored=false. A failed request may have committed a league: reconcile before retrying.

Read GET `/api/leagues/{id}/events?showAll=true&page=1&pageSize=200` through all pages. Read GET `/api/events/{id}`. PUT `/api/events/{id}` accepts monitored=true as a partial update. POST `/api/events` accepts externalId, title, sport, internal leagueId, eventDate, season, monitored, searchOnAdd. POST `/api/event/{eventId}/automatic-search` queues a search. GET `/api/queue` returns eventId, status, progress and error information. Download completion alone is not availability: use imported event file state and monitored multipart coverage.

Native write endpoints are source-verified but are not all covered by the stable read contract. Establish an explicit supported-version range with a real installation before claiming compatibility. Never enable all seasons to fulfill one event. Preserve existing manager settings.

The public contract was rechecked during adapter implementation. There is no documented public popularity ranking; Pedirr ranks its own non-rejected league requests. Public season detail uses GET `/api/public/v1/seasons/{identifier}`.

Sportarr connection implementation rechecked the pinned source: `src/Program.cs` defines native `/api/system/status` with `appName=Sportarr` and the full version. `src/Endpoints/TagAndQualityProfileEndpoints.cs` defines `/api/qualityprofile`. The compatibility `/api/v3/system/status` advertises `appName=Sonarr`, so it is intentionally not used for native identity detection.

## Event parts

Checked against the Sportarr 4.1.11 source (`v4.1.11` tag) and unchanged in 4.1.12. GET `/api/config` returns `enableMultiPartEpisodes`. GET `/api/library/parts/{sport}` returns `{parts:[{name,partNumber}]}` for a sport (`Combat` is a fighting sport), and GET `/api/event/{id}/parts` returns the event-aware set (for example no Early Prelims on Fight Night style events; ACA and weekly wrestling have none). Both include the `Full Event` pseudo part with number 0, which Pedirr never offers. PUT `/api/events/{id}/parts` with `{monitoredParts:"Prelims,Main Card"}` replaces an event's monitored parts; `null` inherits the league and the value `Full Event` keeps one whole file. Sportarr judges completeness by part number against the effective monitored parts (event value, else league value, else all), ignores the optional `Post Show`, and treats a file with no part number (or part `Full Event`) as the whole event. Pedirr mirrors the optional Post Show in its own availability (it never blocks when other parts were requested) and stops searching it seven days after the event. Pedirr only adds parts to an existing value, never writes when the effective value is null (all parts), and never changes a `Full Event` event.

## Native write adapter verification

The pinned `src/Version.cs` reports 4.1.11. Write compatibility currently admits 4.1 patch versions >= 11 and rejects other minor/major versions until their behavior is reviewed. The gate was set from the source; Pedirr has since run against a live 4.1.11 installation (see Live validation).

`LeagueAddService` may commit before failing later initialization. New Pedirr-owned league containers use `monitored=false`, `monitorType=None`, and no team selection. Existing leagues are returned without writes. Per-event monitoring uses only PUT `monitored=true`; existing profile, team, multipart, and season preferences remain untouched. Event creation uses `searchOnAdd=false`, allowing the worker to schedule searches separately and track retries.

`CreateEventRequest` defines native event fields. POST `/api/events` can return a raw event or `{event,alreadyAdded}`; it also deduplicates by title/date. The adapter reads the clean event DTO afterward and requires exact external ID and league ID before accepting it. A timeout is reconciled using a complete event listing before retrying a write.

`DownloadStatus` in `src/Sportarr.Data/Models/Download.cs` is an integer enum (Queued=0, Downloading=1, Paused=2, Completed=3, Failed=4, Warning=5, Importing=6, Imported=7, ImportPending=8, ImportWarning=9). Startup JSON options do not register a string enum converter. The adapter accepts those numeric values and their explicit names, and normalizes them to names. Imported file state, not these queue statuses, will determine availability.

## Live validation

Since November 2026 the maintainer has run Pedirr against a real Sportarr 4.1.11 installation. Event requests were approved, monitored, searched, downloaded, imported and reported as available, including UFC cards split into parts. That use exposed the event-level search repeatedly choosing the part already held, which led to per-part searches in 0.2.0.

Not yet exercised against a live installation: choosing event parts per request and the optional Post Show (unreleased at the time of writing), and other Sportarr versions than 4.1.11.
