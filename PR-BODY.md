## fix(a11y): /platform's money picture fits a 320 px screen (WCAG 1.4.10, 1.4.12, 274 [AX1])

Found in the measured browser sweep outside the studio (Claude 4, cloud AA, 15 November 2026). The "Where a $27 sale goes" picture on /platform (`components/feature-visuals.tsx`, `StripeVisual`) lays out its steps in a `grid` with no column size.
- An implicit grid column is as wide as its widest item's min-content. A truncated line (`white-space: nowrap`) has the whole line as its min-content.
- So at 320 px the column grew to 301 px inside a window that clips (`overflow-hidden`). "$27.00" and "On the payout schedule you set at Stripe" were cut off, and nothing could scroll them into view.

The change:
- The column is `grid-cols-1` (`minmax(0, 1fr)`), so it is no wider than the window.
- The two steps use `Row`'s existing `wrap`, so their lines wrap instead of ending in an ellipsis.
- `tests/platform-money-visual-reflow.test.ts`: the RED commit is 5787aa994e, which fails on main.

## Acessibilidade
- **Criteria:** 1.4.10 Reflow (AA), 1.4.12 Text Spacing (AA).
- **Method:** a production build (`next build` + `next start`), Chromium at 320 px. For each clipping box, the probe measured how far it overflows (`scrollWidth − clientWidth`) and which text ranges reach past its right edge. It ran with the page's own spacing, and with 1.4.12's spacing injected (line height 1.5, letters 0.12em, words 0.16em).
- **Results on /platform at 320 px (box overflow):**

  | Spacing | Before (main) | After (572db9c092) |
  | --- | --- | --- |
  | Page's own | 35 px ("$27.00" cut by 16 px, the payout line by 19 px) | 0 |
  | 1.4.12 | 106 px | 0 |

  `/` at 320 px: 0 after. /pricing, /accessibility, /privacy, /terms, /refunds, /status and /report: 0 on main already.
- **Tests:** `platform-money-visual-reflow` 4/4; `feature-visual-cards`, `feature-visual-funnels`, `phone-overflow` and `platform-status-contrast` pass.
- **Not checked:** the other pictures at 1.4.12 on topic pages other than /platform; Firefox and WebKit, real devices, screen readers, testing with people. Passing automation is not a claim of conformance.
- **Steps and decisions for the main task:** 0 → 0.
