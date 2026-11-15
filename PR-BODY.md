## fix(a11y): colour utilities over a site class apply, except the two danger reds (WCAG 1.4.6)

Asked by the Claude 4 coordinator on 15 November 2026 (AA → ALL), after the finding in #4765.
- Most of `app/globals.css` is outside any `@layer`, and an unlayered rule beats Tailwind's layered utilities whatever their specificity.
- So seven colour utilities placed on an element that also carries a site class setting `color` never applied. Only the `!` variant applies over an unlayered rule.

The coordinator's conditions:
- measure each one before and after, light and dark, at rest, hovered and focused;
- apply it only if nothing drawn falls under 7:1 for text;
- otherwise keep today's colour and write down the reason;
- do not touch the other 564 or the layer order.

| Where (page) | Element | Before (site class) | After, colour asked for | Decision |
| --- | --- | --- | --- | --- |
| calendar-editor:269 (/studio home, calendar) | stop notice, `notice-warn` + `text-ink` | 7.06:1 light; 2.00:1 dark | 16.12:1 light; 13.88:1 dark | **Applied** (`text-ink!`) |
| closing-refunds-confirm:96 (/studio/closing-refunds) | error, `notice-warn` + `text-ink` | 7.06:1 light; 2.00:1 dark | 16.12:1 light; 13.88:1 dark | **Applied** (`text-ink!`) |
| blog-editor:267 (/studio/blog) | delete, `btn-ghost` + `text-danger` | 16.28 / 17.74:1 light | 5.37:1 on page, 5.85:1 in card, 4.96:1 hovered | Kept, reason in the source |
| workflow-tools:326 (email studio) | "Failed" count, `tag` + `text-danger` | 9.31:1 | 4.96:1 | Kept; the word "Failed" carries the meaning |
| call-editor:469 and :969 (/studio/community, product editor) | length hints, `field-hint` + `text-ink` | 9.42–10.26:1 light; 1.72:1 in a dark card | 16.28–17.74:1 light; 1.12:1 in a dark card | **Applied** (`text-ink!`), coordinator's decision: passes on the live light theme; in the dormant dark the card is the defect, and it fails before (1.72:1) and after (1.12:1) alike |
| feature-visuals:1104 (/platform, the "AI writing" picture) | sample field, `field` + `text-ink-mute` | 17.74:1 light; 1.12:1 dark | 10.26:1 light; 1.72:1 dark | **Applied** (`text-ink-mute!`), coordinator's decision: passes light (10.26:1); dark fails before (1.12:1) and after (1.72:1) alike |

**About the dark figures:** they use the **dormant** dark tokens (`:root[data-color-scheme="dark"]`, which nothing sets yet), applied to measure. Under them a `.card` stays white while the ink turns light, so several items fail **before** this change too. The live site is light only. The coordinator decided (15 Nov 2026, 13:43 UTC) that the call hints and the sample field apply: the dark-mode defect is the card, not the class. That is recorded in #4765 as a finding for dark mode stage 2.

- `tests/colour-intents-apply.test.ts`:
  - RED commit cdf1d6b702, which fails on main (14 of 21 checks).
  - Each of the five applied items must carry `utility!`. The two kept danger reds must carry no colour utility at all and must say why in the source.
- Not touched: the other 564 unlayered clashes, and the layer order of `app/globals.css` (left for Claude 1).

## Acessibilidade
- **Criteria:** 1.4.6 Contrast (Enhanced, AAA), 1.4.3; 1.4.1 for the danger red (the word carries the meaning).
- **Method:** a production build (`next build` + `next start`), Chromium at 1280 px. Each element was drawn with its real classes and the built CSS, on the page's background and inside a `.card`.
  - Rest: computed colour against the first opaque background.
  - Hover: the mouse on the element.
  - Focus: Tab onto the button.
  - Light, and dark through `data-color-scheme="dark"`.
  - The elements were injected into /help with their classes, not reached in each studio screen's own state.
- **Tests:** `colour-intents-apply` 21/21; the 26 tests that read the six components pass; tsc after typegen and ESLint are clean.
- **Not checked:** each studio screen reached in its real state, Firefox and WebKit, real devices, screen readers, testing with people.
- **Steps and decisions for the main task:** 0 → 0.
