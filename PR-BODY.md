## Summary

Fixes #4629. AX274 Part A (WCAG 2.2 AAA, 2.5.5 Target Size (Enhanced)) on every studio page:

- **The studio header's logo link** (`components/studio-header.tsx`) is now an `inline-flex` box at least 44 × 44 px. It was 153 × 40 px on a wide screen and 32 × 32 px on a phone, where only the mark is drawn.
- **The trail's links** (`components/breadcrumb.tsx`, used by every studio page's trail and by the public trail) get `min-w-11`, so a short word such as "Studio" (41 px wide) is a whole 44 × 44 target.

First seen by Claude 4 cloud P's studio audit and left to the files' owners; still present on main. No price, limit, commission, flag, gate, words or creator content changed. No overlay or widget.

## RED → GREEN

`tests/studio-header-targets.test.ts` renders the real `Breadcrumb` and reads the header's logo link. On main, 2 of 5 checks fail: the trail link has no minimum width, and the logo link is not a 44 × 44 box. On this branch, 5 of 5 pass. The 8 tests that name the trail or the studio header pass. `tsc`: no error.

## Acessibilidade

**Criteria checked:** 2.5.5 Target Size (Enhanced); 1.4.10 Reflow at 320 px; the whole axe-core rule set (wcag2a/aa/aaa, wcag21a/aa, wcag22aa, best-practice, `color-contrast-enhanced`).

**Method:** a local production build of this branch, seeded with the e2e fixture store, with the synthetic creator session. Playwright on the pre-installed Chromium with axe-core 4, on `/studio`, `/studio/tax`, `/studio/add`, `/studio/team` and `/studio/blog`, at 1280, 390 and 320 px, plus a geometry check of every visible target.

**Results:**
- Before (main, all 43 studio pages): the logo was 153 × 40 and 32 × 32 on a phone, and "Studio" was 41 × 44.
- After: neither appears among the targets under 44 px on any page or width. No new axe violation, and no horizontal overflow at 320 px.
- Steps and decisions: 0 → 0.

**Exclusions and gaps:**
- Firefox and WebKit were not run locally.
- No real assistive technology or person tested it.
- Left to open work, and not repeated here:
  - the "Studio sections" bar at 36 px (#3757);
  - checkboxes at 13 px outside a 44 px label (#3759);
  - "Blog" (35 px) and "Inbox" (43 px) on `/studio/add`;
  - the duplicate landmark name on `/studio/team`.
