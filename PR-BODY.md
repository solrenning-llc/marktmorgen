## fix(a11y): a sideways list of controls brings the focused one into view (WCAG 2.4.12, 274 [AX1])

Found in the measured browser sweep outside the studio (Claude 4, cloud AA, 15 November 2026). At 320 px, the help center's "Sections" list scrolls sideways. Chromium scrolls a focused control into view only when the control is wholly hidden, so a link that is partly in view is not moved. Tabbing along the list left most of three links, and their focus rings, outside the list.

- `components/reveal-focus.ts`: `revealFocused`, an `onFocus` handler for the list. It calls `scrollIntoView({ block: "nearest", inline: "nearest" })` on the focused control. "Nearest" moves nothing when the control is already in view; otherwise it moves the least distance. The page's own `scroll-behavior` decides whether the scroll glides.
- `components/focus-reveal-list.tsx`: a client `<ul>` carrying the handler, for server pages. Without JavaScript it is a plain list.
- `app/help/page.tsx`: the Sections list uses it.
- `components/feature-catalogue.tsx` (the features filter on /platform): it carries the handler too, as prevention. The defect was **not** reproduced there (0 px cut with the handler disabled), because the scan holds every sideways list of controls outside the studio to the same rule.
- `tests/focus-reveal-scrollers.test.ts`: the RED commit is 60f339e2e, which fails on main.

## Acessibilidade
- **Criteria:** 2.4.12 Focus Not Obscured (Enhanced, AAA); 2.4.11 (AA); 2.4.7.
- **Method:** a production build (`next build` + `next start`). Chromium 320 × 800, real Tab presses, a 400 ms settle, then the focused control's box measured against its scrolling list. "Before" is the same build with the handler disabled: a capture `focusin` listener on the list stops React's `onFocus`, which is the behavior of `main`.
- **Results on /help (pixels of the focused link outside the list):**

  | Link | Before | After |
  | --- | --- | --- |
  | The demo store | 42 | 0 |
  | Your store | 103 | 0 |
  | Outreach | 71 | 0 |
  | All 7 links | — | 0 |

  /platform: 0 before and 0 after on its 5 filter buttons.
- **Tests:** `focus-reveal-scrollers` 7/7. `buyer-help`, `question-block` and `type-scale` pass. tsc is clean after typegen; ESLint is clean on the changed files.
- **Out of scope:** the studio's own section bar (`components/studio-start.tsx`) has the same pattern; its file is in #3757.
- **Not checked:** Firefox and WebKit, real devices, screen readers, testing with people. Passing automation is not a claim of conformance.
- **Steps and decisions for the main task:** 0 → 0.
