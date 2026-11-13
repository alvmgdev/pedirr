# Pedirr visual identity

Pedirr is a sports video library where people discover and request seasons and events. Artwork identifies the content; dates explain which edition or fixture is being requested.

## Design plan

Palette: carbon #101014, shelf #19191f, raised surface #24242d, paper #f3f0e7, secondary ink #aaa5b6, ticket gold #d9b76e. Dark is the only theme. Transparent logos retain a neutral gray backing so white lettering remains visible.

Typography: locally hosted Barlow for controls and reading; Barlow Condensed for titles and fixture names. Left-aligned text, compact controls, generous artwork, readable descriptions below 80 characters per line.

Layout alternatives: a sidebar with compact rows offers familiar administration but reduces the space available for artwork. A horizontal navigation with content shelves makes the catalog the primary experience and keeps administrative screens straightforward. Choose the latter.

The horizontal header contains the brand, primary navigation, and account actions. Below it, search precedes category filters and artwork shelves. Details present artwork beside the title and request action. User management has a read-only directory with dedicated editing screens.

## Review against the brief

Avoid a generic streaming-service hero with invented featured content. Use actual catalog results, grouped by entity type, with large image areas and dates on event cards. Keep settings as forms rather than turning every element into a decorative card. No gradients, oversized statistics, stadium placeholders, or theme toggle. Cards represent content; panels represent tasks.

Global Hub search preserves provider relevance because its contract has no date ordering parameter. Scoped event browsing requests descending scheduled dates from Hub; upcoming discovery remains ascending.

## Verification

Review desktop and mobile screenshots, keyboard navigation, contrast, empty/error states, image fallback, and English/Spanish layouts. Verify user editing is absent from the directory and lives on its own route.

## Upstream ordering contract

Verified against https://sportarr.net/openapi-partner.json: `/api/public/v1/search` accepts `q`, `types`, and `limit` (per entity type), with no sorting parameter. `/api/public/v1/events` accepts `order=asc|desc|episode`. Pedirr exposes chronological `asc|desc` for scoped browsing and uses `asc` by default for background enumeration. Category grouping preserves the relative order of returned matches and does not imply an exhaustive search of the entire catalog.

## Implementation review

A request page keeps its actions in the right-hand column of the heading, as on catalog details: follow (or request parts), report a problem, and the administrator review. Reporting a problem opens a dialog styled like the parts dialog; the viewer's issues about the request are listed at the end of the page.

Issues reuse the request vocabulary: a hairline list with the problem in Barlow Condensed and the affected content underneath, and a conversation built on the history timeline, where status changes read as gold "Marked as" lines. Reporters see administrator replies as "Administrator". The navigation adds Issues with a small gold count; on phones Administration shortens to "Admin" (the accessible name stays complete) and the bar scrolls rather than the page if it ever overflows.

The brand mark is aligned like a letter of the wordmark: baseline alignment and a height of 0.74em, the ascender height of Barlow Condensed, so it spans from the top of the "d" to the baseline at every size. A browser test checks both edges within 1 px.

Event parts use a native modal dialog listed in card order, like a bout sheet: a hairline row per part with its name in Barlow Condensed and its state on the right (already requested in ticket gold, in the library in green and disabled, optional parts labelled). The checkbox is named by the part and described by its state. Request details list each part with its status and mark the viewer's own parts.

The dark catalog uses real upstream imagery and neutral missing-image artwork. Sparse league and team groups share a row on desktop; mobile uses two artwork cards per row. Event labels include the year. The user directory contains navigation links only; creation and editing each have a dedicated route. Browser checks run against the production bundle to avoid development-module reloads during repeated route navigation.
