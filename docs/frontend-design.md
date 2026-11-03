# Frontend direction

Pedirr is a shared sports schedule with request controls, not a streaming player. Its characteristic surface is a fixture list with readable dates, league context and request status.

## Tokens

- Stadium blue: #163dd5, navigation and primary actions.
- Ink blue: #142a52, body and headings.
- Cloud: #f6f8fc, main background.
- White: #ffffff, focused content surfaces.
- Sea glass: #b7e3dd, available-state background.
- Rust: #a34419, warnings with sufficient contrast on pale backgrounds.

Barlow Condensed 600 carries fixture dates and display headings. Barlow 400/600 carries controls and descriptions. Both ship locally with the app. Body text stays within 75 characters where practical. Dates use tabular numerals.

## Layout alternatives

A poster grid would conceal timing and make sports feel like a film catalog. A schedule-first layout gives dates a consistent column, team/event titles a flexible middle, and request status a stable trailing position. Choose the latter. A compact blue navigation rail anchors a white workspace; on mobile it becomes a top navigation row.

Desktop: navigation rail | page heading and search | date-led fixtures and contextual league links.
Mobile: brand and language | scrollable navigation | search | vertically stacked fixtures.

## Review before implementation

Reject the generic card dashboard: no fabricated statistics, decorative gradients or repeated metric tiles. Use a bold condensed date column as the memorable device. Keep forms and settings quiet, with native labels and visible focus. Event artwork is optional; the layout must work without it. Empty and error states explain the next action. Never show fixture availability based only on catalog metadata.

## Interaction requirements

English and Spanish strings share keys. The locale switch is available before login. Store anonymous preference locally and synchronize authenticated preference through the profile API. All dates use the profile timezone. Search has an explicit submission button to respect provider limits. Loading, errors, pagination, duplicate requests and pending actions are visible. Keyboard navigation and reduced-motion preferences must be respected.

## Catalog artwork refinement

Keep stadium blue #163dd5, ink #142a52, cloud #f6f8fc, white #ffffff and sea glass #b7e3dd; add a pale blue-gray #e9eef5 artwork surround. Preserve Barlow for names and Barlow Condensed for schedule dates/initials. Left-align names and secondary context.

Compare: a full-bleed poster grid would obscure event dates and crop league emblems; a schedule row with a generous artwork panel preserves the date-led identity. Choose separate compact rows with a framed emblem or cropped event photo, clear name hierarchy and right-aligned time. Desktop: date | artwork | event and league | time. Mobile: artwork | name, with date/time below the name. League/team rows omit the date. White-backed logos sit within an inset white plate bounded by the gray surround; never invert or recolor brand artwork. Missing or failed images fall back to word initials. Use existing metadata fields, without per-item discovery calls. Apply the same artwork treatment to requests and detail headings.

## Neutral missing-image artwork and visible filters

Missing or failed artwork uses a small, text-free photo-outline icon on pale blue-gray (`public/images/artwork-default.svg`), replacing the earlier stadium photograph and initials. The vector asset remains crisp at thumbnail size and implies no particular sport or venue. Retain original metadata images whenever available; try alternate existing image fields before the local default. Remove outer artwork borders and nested frames. Transparent logos sit directly on #a8b4c4 so white marks remain distinguishable. Preserve the existing palette, typography and schedule layout.

Request status filters use visible, horizontally scrollable buttons styled as tabs with `aria-pressed`; selecting one resets pagination and preserves personal filtering. Search categories filter the already-returned result set while retaining the query. They do not claim to fetch all matches from the upstream catalog. Buttons remain native keyboard-accessible controls rather than incomplete ARIA tab widgets.
