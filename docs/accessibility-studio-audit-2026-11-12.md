# Studio AAA and ATAG Part B audit (12 November 2026)

AX274 Part A items 4–6. Built from main `cb24ba0b` the way `.github/workflows/accessibility-studio-matrix.yml`
does (`scripts/ci-build.mjs`, the synthetic Harbor Kitchen fixture of `tests/e2e/store-copy-seed.ts`, no real
account, payment or email). Automated checks in Chromium only; Firefox and WebKit run in CI. This is a record
of what was checked, not a conformity claim.

## Screens and modes

Dashboard and page editor at 320, 390, 768, 1280 and 1920 px; site pages, people, emails, numbers, add,
forms, funnels, deals, reviews, checkup and team at 320 and 1280 px. Modes: baseline with ten real Tab
presses, text spacing, reduced motion, forced colors, reflow at 320 px (the stand-in for 400% zoom of a
1280 px window) and dark. axe 4 with every WCAG 2.0–2.2 A/AA/AAA tag plus, by name, heading-order,
page-has-heading-one, landmark-unique, landmark-one-main and landmark-no-duplicate-main.

## Defects found and fixed

| Criterion | Screen / state | Defect | Test |
| --- | --- | --- | --- |
| 3.3.6, 2.2.6 | Look editor, unsaved picks | Leaving the page dropped theme/accent/font picks without asking | `tests/leave-guard.test.ts` |
| 1.4.6 | Deals, chosen pipeline button | Faded count at 5.63:1 | studio matrix (axe `color-contrast-enhanced`) |
| 2.1.1 | Deals, 320 px | Totals table scrolled sideways, unreachable by keyboard | studio matrix (axe `scrollable-region-focusable`) |
| 1.4.12, 1.4.10 | Funnels, 320 px, text spacing | Path badge pushed the page 39 px wide | studio matrix (horizontal overflow) |
| 1.3.1 (best practice) | Team | Two landmarks named "What each role can do" | studio matrix (axe `landmark-unique`) |
| 2.5.5 | Every studio screen | Header logo 32 px; section links 36 px high; trail link 41 px wide; about thirty dashboard buttons and links, six summaries and several checkbox labels 16–40 px | studio matrix (`tests/e2e/target-size.mjs`) |

## Passed by automation (this fixture, Chromium)

1.4.6 everywhere except deals (fixed); 2.4.13 visible focus on the first ten Tab stops; one `h1` per screen and
no skipped heading level; save and error messages in `role="status"`/`role="alert"` regions in the page,
product, look and email editors; 2.5.7 the page editor's drag has buttons that move blocks
(`tests/e2e/page-editor-actions.mjs`); no horizontal scroll at 320 px or with text spacing after the fixes.

## Existing elsewhere, not duplicated

- 2.4.8 trail: present on 8 studio screens; the rest is in progress on `claude6/stn13-trail-rest` (766 [STN13] unit 2b).
- 2.2.6: sessions last 30 days and no studio screen times out; editors that wait for Save ask before leaving
  (`components/leave-guard.ts`). There is no warning before a 30-day session ends while a tab is open.

## ATAG 2.0 Part B before publishing

| Check | State |
| --- | --- |
| Picture without a description | Page editor coach (`lib/page-coach.ts`, "described") and store check (`lib/store-access-check.ts`). Not in the product or email editors. |
| Link or button words without a purpose | Page buttons (`button_words`) and store links (`lib/link-purpose.ts`). Not for links inside emails. |
| Video without captions or transcript | Course lessons only, captions only (`lib/course-access-check.ts`). Page-builder videos (YouTube/Vimeo embeds) and transcripts are not checked. |
| Contrast under 7:1 | Store look and email colors are moved to 7:1 and the creator is told (`lib/store-look.ts`, `lib/email-theme.ts`); not a warning with a choice. Page blocks use the theme's colors only. |
| Heading order | No check; heading levels are assigned by the renderer from the block order (`components/sales-blocks.tsx`), so a creator cannot pick a wrong level. |
| One-click fix the creator approves | Missing: every check is text with a link to where to fix it. |

## Gaps still open

- Real 400% browser zoom, real devices, Windows High Contrast and real screen readers (NVDA, JAWS, VoiceOver,
  TalkBack); the matrix emulates and does not replace them.
- Screens the fixture does not draw (other plan states, filled lists, error states) and the course, podcast,
  community and settings sub-screens not in the list above.
- ATAG Part B: the missing checks and the one-click fix above need a product decision before they are built.
