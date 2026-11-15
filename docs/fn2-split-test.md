# 526 [FN2]: a split test step in a funnel of pages (units 1 to 4)

Status: built and tested on a keep branch, not yet a pull request, not available to customers. Written 15 November 2026 by Claude 4 (cloud V).

## What it does for the creator

A funnel of pages can now have a **Split test** step. Each visitor who reaches it goes to one of 2 to 4 of the store's own pages or products, picked at random on each visit. The creator either splits visitors equally or sets whole percents that add up to 100. The studio shows, for each version (A to D), how many people opened it and how many signed up or paid. It also shows the verdict of the winner rule of 377 [TB3] (`lib/ab-decision.ts`). There is no second statistical rule.

| Unit | What | Where |
| --- | --- | --- |
| 1 | The rules: 2 to 4 destinations, shares, an off-air destination's share passed to the others, the draw, version names a to d | `lib/funnel-split-rules.ts` |
| 2 | The step in the funnel model (`{ kind: "split", id, options }`) and on the visitor's path (the /go route and every page that builds the next link) | `lib/page-funnel.ts`, `lib/page-funnel-store.ts`, `app/[handle]/go/[funnel]/route.ts` |
| 3 | Counts per version (opened, signed up or paid) by the funnel's existing method, and the verdict | `lib/funnel-split-results.ts`, `components/funnel-split-results.tsx` |
| 4 | Building and editing a split in the studio's funnel editor | `lib/funnel-split-draft.ts`, `components/funnel-split-editor.tsx`, `components/page-funnel-editor.tsx` |

## Rules kept

- **Privacy:** a fresh draw on each visit (`crypto.getRandomValues`), no cookie and nothing about the person. Counts are aggregate (HyperLogLog), and the version is read from the page the visitor is on.
- **Unknown is never zero (rule 24):** an unreadable count shows "Count unavailable", never 0. A destination that cannot be shown passes its share to the others. A split with none showable is passed over like any step, never an error page.
- **Limits:** each destination counts as a page in `MAX_FUNNEL_PAGES` (20, unchanged), and each page or product appears once in the whole funnel. `MAX_PAGE_FUNNELS` (10) is unchanged.
- **Cost:**
  - No new Redis command on a visit: the writes are the same `PFADD` + `EXPIRE` under the version's key, in the lines `visits` and `orders`.
  - The studio's reads per version are taken from the `studio` line before they run (`SPLIT_COUNTS_PER_UNIT`, held in `tests/plan-cost-registry.ts`).

## Not real yet

- **Money per version:** the funnel's counters have no revenue, refund or dispute per step. So `abDecision`, which decides by money kept net of refunds, always refuses, and the studio says why. No winner is ever declared from clicks or opens.
- **Thumbnails, the visual map and dragging:** these belong with 535 [MV1], whose thumbnail generator does not exist yet.

## Steps and decisions in the creator's main task (making a split test)

- **Before:** impossible.
- **After, with the defaults:** 3 steps ("Add a split test", "Use this split test", "Save the funnel") and 0 required decisions. The test goes at the end of the funnel, with the first two free pages, split equally.
- **Optional:** the place, the destinations and custom shares.

## Acessibilidade

- **Criteria aimed at (WCAG 2.2 AAA intent, AX274):**
  - 1.3.1: fieldset and legend for the destinations and for how visitors are shared; a label on every select and percent field.
  - 2.5.7: the place is chosen from a list, never by dragging.
  - 3.3.1 and 3.3.3: errors in text next to the field, prefixed "Error:", with `aria-invalid` and `aria-describedby`.
  - 4.1.3: the total is announced in a polite live region ("Total: 90%. The shares must add up to 100%.").
  - 3.3.6: a review before the button that applies the split.
  - 2.4.3: focus goes to the form's heading on open and back to the button that opened it on close.
  - 1.4.1: the results are a table with a caption and header cells; the winner is named only in text.
  - 3.1.5: plain words, with a one-sentence explanation in place that says the winner is decided only by net sales after refunds, never by clicks.
- **Method:**
  - Markup tests (`tests/fn2-split-editor.test.ts`, 46 checks; `tests/fn2-split-results.test.ts`, 38).
  - Chromium (Playwright) keyboard-only on a harness that renders only the split form: the live region updates, the error and `aria-invalid` appear, and Tab then Enter applies the split.
- **Not done, and listed as gaps, not passes:**
  - the whole studio editor in a browser;
  - contrast and target sizes measured with the real CSS;
  - a real screen reader;
  - 400% zoom and forced colors;
  - testing with people.

## Tests

- New: `fn2-split-rules` (29), `fn2-split-funnel` (41), `fn2-split-results` (38) and `fn2-split-editor` (46).
- Also passing: `page-funnel` (74), `page-funnels-focus`, `accessibility-inventory`, `accessibility-statement`, `plan-cost-registry`, `store-data-registry` and every test that imports a touched file.
- Each unit was written RED first. The RED commits are kept on `claude4/keep/fn2-split-rules`.
