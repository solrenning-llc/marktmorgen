## fix(a11y): a topic page's badges wrap instead of being cut (WCAG 1.4.12, 274 [AX1])

Found in the measured browser sweep outside the studio (Claude 4, cloud AA, 15 November 2026). A topic page's badges under its title are `.tag`s. A `.tag` never wraps (`white-space: nowrap`) and is 26 px tall. On /proof/creator-showcase at 320 px with 1.4.12's text spacing, "Permission registry reviewed 2026-10-20" ran 18 px past the hero, whose box clips (overflow 27 px).

The change:
- `components/topic-page.tsx`: the hero's two badges get `h-auto! min-h-[26px] whitespace-normal! py-1!`. A long badge takes a second line.
- **Why `!`:** `.tag` is an unlayered rule in `app/globals.css`, and an unlayered rule beats Tailwind's layered utilities. This was measured: with plain `whitespace-normal` (commit 427b7c1db8), the build still drew the badge `nowrap` and 26 px tall. Commit 1ae869e3f2 uses the important variants, and the test asks for them.
- `tests/topic-badge-wrap.test.ts`: the RED commit is 21228e8a5e, which fails on main.

## Acessibilidade
- **Criteria:** 1.4.12 Text Spacing (AA); 1.4.10 Reflow (AA).
- **Method:** a production build in Chromium at 320 px, on all 32 prerendered /for and /proof pages. For each clipping box, the probe measured how far it overflows and which text ranges reach past its edge. It ran with the page's own spacing, and with 1.4.12's spacing injected (line height 1.5, letters 0.12em, words 0.16em).
- **Results:**

  | Measurement | Before (main) | Plain utilities | `!` utilities (1ae869e3f2) |
  | --- | --- | --- | --- |
  | /proof/creator-showcase, 1.4.12 spacing | badge cut by 18 px | unchanged | 0 |
  | All 32 pages, both spacings | — | — | 0 |

- **Tests:** `topic-badge-wrap` 4/4; the 14 other tests that read `components/topic-page.tsx` pass.
- **Not checked:** Firefox and WebKit, real devices, screen readers, testing with people. Passing automation is not a claim of conformance.
- **Steps and decisions for the main task:** 0 → 0.
