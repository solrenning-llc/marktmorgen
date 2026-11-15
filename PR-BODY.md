## Summary

Fixes #4599. AX274 Part A (WCAG 2.2 AAA) on the public site's shared header and footer, on every public page except the home page:

1. **2.5.5 Target Size (Enhanced).** The header's menu buttons, "Pricing", "Blog" and "Log in" go from 40 px to 44 px tall (`h-10` → `h-11`). The header row is 64 px, so the layout does not move. The footer links get `min-w-11`, so short words such as "Blog" (31 px) are 44 × 44.
2. **Landmarks (1.3.1, axe `region`).** The sticky header block is now a `<header>`, so the logo, "Log in" and "Start your store" sit inside the banner landmark with the "Main" navigation. It is the sticky element itself, so it still sticks for the whole page. The dark line about what is built today is a `<section aria-label="What is built today">`, kept outside the sticky part so it still scrolls away.

No price, limit, commission, flag, gate, legal wording or creator content changed. No overlay or widget.

## RED → GREEN

`tests/public-header-targets.test.ts` renders the real `SiteNav` and `SiteFooter`. On main, 9 of its 11 checks fail: six header targets with `h-10`, 39 footer links without a minimum width, no `<header>`, and the line not a named region. On this branch, 11 of 11 pass.

## Acessibilidade

**Criteria checked:**
- 2.5.5 Target Size (Enhanced), AAA;
- 1.3.1 Info and Relationships (landmarks; axe `region`);
- 2.4.1 Bypass Blocks (the skip link stays first);
- 2.4.7 and 2.4.13 Focus Visible and Focus Appearance (unchanged: 3 px outline);
- 1.4.6 Contrast (Enhanced) and 1.4.10 Reflow (unchanged).

**Method:**
- The unit test above, on the real components.
- A local production build of this branch, with Playwright on the pre-installed Chromium and axe-core 4 (`wcag2a/aa/aaa`, `wcag21a/aa`, `wcag22aa`, `best-practice`, `color-contrast-enhanced`), on `/help`, `/terms`, `/blog`, `/status` and `/creators` at 320 and 1280 px.
- A geometry check of every visible target.
- A scroll check: after 3000 px of scroll, the `<header>` top is 0 at 390 and 1280 px.

**Results:**
- axe `region` is gone on all five pages (main reported 2 to 4 nodes on each).
- No header or footer target is under 44 × 44 px.
- No new axe violation.
- The landmark order is: the line, `header`, `nav Main`, `main`, `footer`.
- Steps and decisions for the creator's main task: 0 → 0 (no interaction changed).

**Exclusions and gaps:**
- Firefox and WebKit were not run locally.
- No real assistive technology, voice control or person tested it: these are gaps, not passes.
- The home page has its own header and was not changed.
- The "On this page" index (30 px), the home FAQ and the platform links are #4153 and #4154 (PR #4242). The `/developers` code samples are #4155.
- `/blog` (a post title link 34 px tall) and `/creators` (three 20 × 20 targets) were seen but are not part of this change. They are reported separately.
