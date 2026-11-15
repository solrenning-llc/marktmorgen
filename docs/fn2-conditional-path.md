# 526 [FN2]: a conditional path step in a funnel of pages (unit 5)

Status: built and tested on a keep branch, stacked on the split test (`docs/fn2-split-test.md`). Not yet a pull request and not available to customers. Written 15 November 2026 by Claude 4 (cloud V).

## What it does for the creator

A funnel of pages can now have a **Conditional path** step. Each visitor goes to one of the store's own pages or products by the first rule they match, out of 1 to 4 rules in order. Anyone who matches no rule goes to the page set for everyone else (`otherwise`, required).

The step is shaped `{ kind: "branch", id, rules: [{ if, value?, to }], otherwise }` (`lib/funnel-branch-rules.ts`). The visitor's path is in `lib/page-funnel.ts`, `lib/page-funnel-store.ts`, the /go route and every page that builds the next link. The studio editor is in `lib/funnel-branch-draft.ts` and `components/funnel-branch-editor.tsx`.

## The conditions, all from what the request already knows

- **Source or campaign:** `utm_source` or `utm_campaign` equals a word the creator typed. The tags are read and cleaned as `lib/came-from.ts` already does (`cleanSourceTag`, `cleanCampaignTag`). In a funnel with such a rule, the next links carry the two tags forward; otherwise the links are unchanged.
- **Device:** a phone or a computer, from the request's `User-Agent`. It is read on that request only and never stored, and a tablet counts as a computer.
- **Bought or declined the offer before:** only where the funnel already knows it without storing anything. The thank-you page knows the order was paid, and the product page's "No thanks" knows it was not. So this rule is allowed only right after a product step, and the save route refuses it anywhere else.
- **Not used:** the conditions of `lib/flows.ts`. They are about a person on the creator's list, and a funnel visitor is no one on that list. They were not copied either.

## Rules kept

- **Unknown never matches (rule 24):** with no tag, no browser name, or a visit from elsewhere, the visitor goes to `otherwise`. A destination that cannot be shown falls through to the next rule that matches, then to `otherwise`. If that cannot be shown either, the step is passed over like any step.
- **Limits:** each destination counts as a page in `MAX_FUNNEL_PAGES` (20, unchanged) and appears once in the whole funnel.
- **Privacy and cost:**
  - Nothing about the person is stored, and there is no cookie.
  - On a visit, the /go route makes no write and no key, only the same reads as before (asserted in `tests/fn2-branch-funnel.test.ts`).
  - Counts use the step's own existing keys; there is no count per rule.

## Steps and decisions in the creator's main task (making a conditional path)

- **Before:** impossible.
- **After:** 8 steps.
  1. Add a conditional path.
  2. Choose the place.
  3. Choose the condition.
  4. Type the tag's word (only for a tag rule).
  5. Choose the page.
  6. Choose the page for everyone else.
  7. Use this conditional path.
  8. Save the funnel.
- **Defaults** come ready: one "phone" rule and two free pages. With them, the required decisions are only what the creator wants different.

## Acessibilidade

- **Criteria aimed at (WCAG 2.2 AAA intent, AX274):**
  - 1.3.1: fieldset and legend for the rules and for each rule, and a label on every field.
  - 2.5.7: the place is chosen from a list, never by dragging.
  - 3.3.1 and 3.3.3: errors in text next to the field, with `aria-invalid` and `aria-describedby`; the tag field's hint is linked with `aria-describedby`.
  - 3.3.6: a review before the button, listing where each visitor goes; the button stays off while there is an error.
  - 2.4.3: focus goes back to the button that opened the form.
  - Buttons at full size (no `btn-sm`).
  - There is no live region, because no total changes while typing.
- **Method:** markup tests (`tests/fn2-branch-editor.test.ts`, 34 checks; `tests/fn2-branch-funnel.test.ts`, 43).
- **Not done, and listed as gaps, not passes:**
  - the editor in a browser;
  - contrast measured with the real CSS;
  - a real screen reader;
  - 400% zoom and forced colors;
  - testing with people.

## Not yet

- Counts per rule.
- Tags on the thank-you page for checkouts made before the tags were kept in the payment's metadata: the tag rule is unknown there, so the visitor goes to `otherwise`.
- From FN2 as a whole: the visual map with thumbnails, dragging, and an "End of funnel" marker per branch (with 535 [MV1]).

## Tests

- New: `fn2-branch-funnel` (43) and `fn2-branch-editor` (34).
- Also passing: every `fn2-*` test, `page-funnel`, `page-funnels-focus`, `accessibility-inventory`, `accessibility-statement`, `plan-cost-registry`, `store-data-registry` and the 121 files that import a touched file.
- Written RED first. The RED commits (04022a593, f3fe4e6f1) are kept on `claude4/keep/fn2-split-rules`.
