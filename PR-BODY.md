## Summary

Fixes #4623. AX274 Part A (WCAG 2.2 AAA, 1.4.6 Contrast (Enhanced)) on `/studio/deals`. Each pipeline button's " · N open" and " · view only" were drawn at `opacity-80`, which blends the button's own text into its background: 5.63:1 on the chosen pipeline, and 6.88:1 on hover. They now take the button's full text color: 7.75:1 chosen, 9.75:1 on hover, and 17.74:1 on the others. The words and the layout do not change.

First found by Claude 4 cloud P's studio audit (`docs/studio-accessibility-audit-2026-11-11.md`) and left to the file's owner; still present on main.

No price, limit, commission, flag, gate or creator content changed. No overlay or widget.

## RED → GREEN

`tests/deals-board-tab-contrast.test.ts` reads the pipeline buttons in `components/deals-board.tsx`. On main, "no opacity is laid on their text" fails (1 of 3). On this branch, 3 of 3 pass. The 14 tests that name `deals-board` pass.

## Acessibilidade

**Criteria checked:** 1.4.6 Contrast (Enhanced), and 1.4.11 Non-text Contrast (unchanged).

**Method:** the WCAG relative-luminance formula on the CSS tokens in `app/globals.css` (`.btn-primary` white on `#4946a6`, hover `#3b3890`; `.btn-secondary` `#111827` on white and on `#f7f5f0`), with and without the 0.8 alpha blend. Before the fix, it matches cloud P's 5.63:1 measured in Chromium.

**Results:**

| Button | With `opacity-80` (main) | Without (this branch) |
| --- | --- | --- |
| Chosen pipeline | 5.63:1 | 7.75:1 |
| Chosen, on hover | 6.88:1 | 9.75:1 |
| Other pipelines | 9.45:1 | 17.74:1 |

Steps and decisions for the creator's main task: 0 → 0.

**Exclusions and gaps:**
- Not opened in a browser on this branch: the e2e seed has no pipelines on a plan with deals.
- Dark mode: the studio does not change its colors yet.
- No real assistive technology or person tested it.
