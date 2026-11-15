## Summary

Fixes #4613. AX274 Part A (WCAG 2.2 AAA, 2.5.5 Target Size (Enhanced)) on every page of a creator's store, not only its front page.

A link drawn as `.st-footer-link` usually stands alone: "Back to <store>" on the tip page, "Visit <store>'s store" on the letters page, and the way back from a form, a group, a certificate or an agreement. Its 44 px rule in `app/globals.css` was scoped to `[data-store-layout]`, which only the store front carries. On every other store page the link was 20 px tall.

- The rule is now `.st-footer-link:not(summary, figcaption > *, .st-in-sentence)` on every page, with the same declarations (inline-flex, centered, `min-height: 2.75rem`). The `summary.st-footer-link` rule (a 44 px row by its padding, keeping the disclosure triangle) also holds everywhere.
- The three uses that sit inside a running sentence are marked `st-in-sentence` and keep breaking with their sentence, as 2.5.5 allows:
  - "Open it again" after the group notice (`app/[handle]/group/[group]/page.tsx`);
  - "More" after the affiliate notice (`components/affiliate-click.tsx`);
  - "More" after the ad-measurement notice (`components/store-pixels.tsx`).

No price, limit, commission, flag, gate, words or creator content changed. No overlay or widget.

## RED → GREEN

`tests/store-link-targets.test.ts` checks the rule in `app/globals.css` and scans every `.st-footer-link` in `app/` and `components/` that follows words in a paragraph. On main, 6 of its 7 checks fail: the rule is front-only, the summary rule is front-only, and three in-sentence links are unmarked. On this branch, 7 of 7 pass.

`tests/store-front-accessibility.test.ts` now reads the same rules under their new, unscoped selectors. It keeps its assertions unchanged and its 32 checks pass.

## Acessibilidade

**Criteria checked:** 2.5.5 Target Size (Enhanced) (AAA), 1.4.10 Reflow, 1.4.6 Contrast (Enhanced), the whole axe-core rule set (wcag2a/aa/aaa, wcag21a/aa, wcag22aa, best-practice, `color-contrast-enhanced`), and `lang`.

**Method:** the unit tests above, plus a local production build of this branch seeded with the e2e fixture store (`tests/e2e/seed.ts`, services stand-ins). Playwright on the pre-installed Chromium with axe-core 4 ran on 27 store routes (front, contact, community, waitlist, tip, join, free, review, letters, affiliates, orders, thanks, resting, left, discord, and five products with their reviews) at 320 and 1280 px, with a geometry check of every visible target.

**Results:**
- Before (main): `/@shop/tip` "Back to …" was 195 × 20 and `/@shop/letters` "Visit …" was 222 × 20.
- After: no target under 44 × 44 on the 54 route-and-width cases, no axe violation and no horizontal overflow.
- Steps and decisions for the buyer's main task: 0 → 0.

**Exclusions and gaps:**
- Firefox and WebKit were not run locally.
- No real assistive technology, voice control or person tested it: these are gaps, not passes.
- The group page, the affiliate notice and the ad notice were not opened in a browser in this run; their links are only checked by the source scan.
- Routes that need a signed-in buyer or a live product state (a course lesson, a podcast, a booking, a certificate, an agreement, a payment request) were not opened in a browser.
