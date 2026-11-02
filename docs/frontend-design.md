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
