## Summary

Fixes the button part of #4787 (AX274 Part A / 310 [AX2], WCAG 1.4.4 Resize Text, AA; 1.4.10). `.btn` kept `white-space: nowrap` with no `max-width` at every width above 479 px. With text at 200%, a long label pushed the studio past the screen: 21 px on /studio ("Turn on two-step login", "Turn more on in Stripe") and 129 px on /studio/funnels (every "See the journey and what you need: …").

One top-level rule in `app/globals.css` applies, at every width, to a `.btn` outside a store page body (store pages keep their container rule):
- `max-width: 100%`, `white-space: normal` and `text-align: center`, so a label breaks onto a second line only when it is wider than its room;
- `flex-shrink: 0`, so a button in a row keeps its own width, as `nowrap` did.

## RED → GREEN

- RED, `tests/button-text-resize.test.ts`: fails 4 of 4 on main.
- GREEN: 4 of 4 pass. The tests that read `app/globals.css` all pass.

## Acessibilidade

- **Criteria checked:** 1.4.4 Resize Text (200%), 1.4.10 Reflow, and no visual change at 100%.
- **Method:** a seeded local build in Chromium, on every /studio route.
  - The root font size was set to 200% at 1280 px, and sideways scroll was measured, along with the outermost elements that pass the screen.
  - Every `.btn`'s box was measured at 100% (1280 and 390 px) before and after the change, on the same seed.
- **Results:**
  - At 200%, /studio went from 21 px to 0 and /studio/funnels from 129 px to 0.
  - At 100%, all 921 buttons in 90 page measurements kept exactly the same width and height.
  - /studio/pages still scrolls 279 px at 200%, because of the editor's sticky side panel. That is a separate cause, tracked in #4787 and not touched here.
- **Not checked:** store pages (`.sp-body`, unchanged), real browser zoom (only the root font size was changed), Safari and Firefox, screen readers.
- Automated checks do not certify conformity.
- **Steps and decisions of the main task:** 0 → 0.
