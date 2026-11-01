# Upstream API research

Investigated before implementation on 2026-11-01. Sportarr source reference: `f3a6b02c927b11ca3893660fa6d1d6176f2df26a`. No private Sportarr installation has been tested.

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
