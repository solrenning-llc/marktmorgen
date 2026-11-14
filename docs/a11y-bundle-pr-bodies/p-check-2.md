# The page coach's picture and button checks open the exact field

Branch `claude3/keep/p-check-2` at `d8d36cef1`, from main.

## What changes
- `lib/page-coach.ts`: "Every picture described" and "Every button says what it does" name the first part of the version being edited that misses them (`CoachCheck.fix`).
- `components/page-coach.tsx`: their "Show me" (with "the first picture with no description" / "the first button whose words say nothing" for a screen reader).
- `components/page-editor.tsx`: `showFix` opens that part and puts the focus in the first description left empty or the first button's words that say nothing; those fields are marked `data-fix`. Nothing is filled in.

## Criteria
- AX274 Part A item 6; ATAG 2.0 B.3.1; WCAG 2.2 2.4.3, 2.4.6.

## Proof
- RED: `tests/page-coach-show-me.test.ts` (the checks, the coach in Chromium, the editor's wiring): 8 of 10 fail on main; 10 of 10 after. 40 page coach, page editor, tap-target, inventory and US-English test files pass; `tsc` clean.

## Accessibility
- Checked: each "Show me" says which item it goes to and hands the editor that part and field; the editor's opening and focus code is checked in its source (the full page editor is not mounted in a browser by this test).
- Not covered: a picture missing a description only in the second version (A/B), or only the product's own picture at the top: no "Show me" is offered for those; the check's words still say where.
- Steps and decisions for the main task: one press instead of finding the part and its field.
- Not checked: real assistive technology, testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3, snapshot 13 Nov 2026 23:15 UTC-3)
- #3530, #3534, #3556, #3558, #3665, #4130: `components/page-editor.tsx` 2-3 (imports).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
