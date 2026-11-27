# Pedirr visual identity

Pedirr is a sports video library where people discover and request seasons and events. Artwork identifies the content; dates explain which edition or fixture is being requested.

## Design plan

Palette: carbon #101014, shelf #19191f, raised surface #24242d, paper #f3f0e7, secondary ink #aaa5b6, ticket gold #d9b76e. Dark is the only theme. Transparent logos retain a neutral gray backing so white lettering remains visible.

Typography: locally hosted Manrope (variable) for everything in the interface, with hierarchy from weight and size: extra bold titles with slightly tight tracking, bold card and part names, and small spaced capitals for navigation, tabs and the active breadcrumb step. Barlow Condensed remains only in the "pedirr" wordmark. Left-aligned text, compact controls, generous artwork, readable descriptions below 80 characters per line.

Layout alternatives: a sidebar with compact rows offers familiar administration but reduces the space available for artwork. A horizontal navigation with content shelves makes the catalog the primary experience and keeps administrative screens straightforward. Choose the latter.

One 60 px bar holds the brand, the sections, a language menu with drawn flags and an account menu (email, time zone, account page, sign out); on phones the sections move to a bottom bar with icons. Every page starts with breadcrumbs from the environment (Pedirr or the reseller's name) whose last step is the page itself in small capitals; standard pages make that step their h1, so the title is never repeated on a line of its own, while events, requests and issues keep a large title of their own below. Section actions and a one-line description sit in a toolbar at the top of the content, beside any filters. Administration uses a grouped side menu (one scrolling row on narrow screens), and notifications are channel tabs sharing one form. Spacing follows a 12/16/24/32 px scale; cards stack with space below, never above.

## Review against the brief

Avoid a generic streaming-service hero with invented featured content. Use actual catalog results, grouped by entity type, with large image areas and dates on event cards. Keep settings as forms rather than turning every element into a decorative card. No gradients, oversized statistics, stadium placeholders, or theme toggle. Cards represent content; panels represent tasks.

Global Hub search preserves provider relevance because its contract has no date ordering parameter. Scoped event browsing requests descending scheduled dates from Hub; upcoming discovery remains ascending.

## Verification

Review desktop and mobile screenshots, keyboard navigation, contrast, empty/error states, image fallback, and English/Spanish layouts. Verify user editing is absent from the directory and lives on its own route.

## Upstream ordering contract

Verified against https://sportarr.net/openapi-partner.json: `/api/public/v1/search` accepts `q`, `types`, and `limit` (per entity type), with no sorting parameter. `/api/public/v1/events` accepts `order=asc|desc|episode`. Pedirr exposes chronological `asc|desc` for scoped browsing and uses `asc` by default for background enumeration. Category grouping preserves the relative order of returned matches and does not imply an exhaustive search of the entire catalog.

## Implementation review

A request page keeps its actions in the right-hand column of the heading, as on catalog details: follow (or request parts), report a problem, and the administrator review. Reporting a problem opens a dialog styled like the parts dialog; the viewer's issues about the request are listed at the end of the page.

Issues reuse the request vocabulary: a hairline list with the problem in bold and the affected content underneath, and a conversation built on the history timeline, where status changes read as gold "Marked as" lines. Reporters see administrator replies as "Administrator". The navigation adds Issues with a small gold count; on phones Administration shortens to "Admin" (the accessible name stays complete) and the bar scrolls rather than the page if it ever overflows.

The brand mark keeps the wordmark's ascender height (0.74em of Barlow Condensed) and is centred on the letters, from the top of the "d" to the bottom of the "p", so it does not look raised beside the descender. A browser test checks the centre and the height within 1 px at every size.

Event parts use a native modal dialog listed in card order, like a bout sheet: a hairline row per part with its name in bold and its state on the right (already requested in ticket gold, in the library in green and disabled, optional parts labelled). The checkbox is named by the part and described by its state. Request details list each part with its status and mark the viewer's own parts.

The dark catalog uses real upstream imagery and neutral missing-image artwork. Sparse league and team groups share a row on desktop; mobile uses two artwork cards per row. Event labels include the year. The user directory contains navigation links only; creation and editing each have a dedicated route. Browser checks run against the production bundle to avoid development-module reloads during repeated route navigation.
