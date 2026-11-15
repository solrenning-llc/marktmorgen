## Summary

Fixes #4632. AX274 Part A in the studio:

1. **WCAG 2.1.1 Keyboard (A), axe `scrollable-region-focusable`.** Eight tables wider than a phone sat in a sideways-scrolling box that could not take the focus. Each box is now a focusable region named after its table, with the same pattern as #4512 for the memberships tables:
   - the deals totals by pipeline;
   - deals across all stages;
   - deals by channel;
   - form answers;
   - the import's first rows, and its rows worth a look;
   - quiz totals and results;
   - DNS records to add.
2. **Landmarks, axe `landmark-unique`.** On `/studio/team` the roles table's region had its section's name. It is now "What each role can do, as a table".

No price, limit, commission, flag, gate, words on the page or creator content changed. No overlay or widget.

## RED → GREEN

`tests/studio-scroll-tables.test.ts` scans `components/` and `app/studio/` for an `overflow-x-auto` box around a `min-w-[…]` table, and reads the team section and its region. On main, 2 of 4 checks fail: 8 boxes are not focusable, named regions, and the region has the section's name. On this branch, 4 of 4 pass. The 27 tests that name these components pass. `tsc`: no error.

## Acessibilidade

**Criteria checked:** 2.1.1 Keyboard; 1.3.1 and landmarks (`landmark-unique`); 2.4.7 Focus Visible (the region takes the studio's focus ring); the whole axe-core rule set (wcag2a/aa/aaa, wcag21a/aa, wcag22aa, best-practice, `color-contrast-enhanced`).

**Method:** a local production build of this branch, seeded with the e2e fixture store, with the synthetic creator session. Playwright on the pre-installed Chromium with axe-core 4, on `/studio/deals`, `/studio/team`, `/studio/forms` and `/studio/import`, at 390, 320 and 1280 px.

**Results:**
- `scrollable-region-focusable` on `/studio/deals` (main, 390 px) is gone.
- `landmark-unique` on `/studio/team` (main) is gone.
- No new violation.
- The one left on `/studio/deals`, `color-contrast-enhanced` on " · 0 open" (5.63:1), is #4623's (`claude4/audit-deals-contrast`).
- Steps and decisions: 0 → 0.

**Exclusions and gaps:**
- The quiz, domain and deal-agenda tables were not opened in a browser (the seed has no quiz, domain or deals), so they are checked by the source scan only.
- Firefox and WebKit were not run.
- No real assistive technology or person tested it.
