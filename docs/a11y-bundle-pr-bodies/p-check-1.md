# The store check's warnings open the exact field to fix

Branch `claude3/keep/p-check-1` at `57fbd2934`, from main.

## What changes
- `components/store-access-check.tsx`: each product picture with no description is a link, "Describe the picture of <title>" (`#alt-<id>`); each vague link is "Change the words of “<title>”" (`#edit-link-<id>`). The general "Go to your products / links" buttons stay.
- `components/use-fix-link.ts`: when the creator presses such a link, the editor that holds the item opens it and the focus goes to the field once it is drawn. Nothing opens before the press and nothing is written. An item the editor does not hold (a product on another page) is left to the link as it is.
- `components/product-editor.tsx` opens that product (closed ones too) and focuses `alt-<id>`; `components/link-editor.tsx` opens that link's form and focuses its words.
- `lib/store-access-check.ts`: `pictureIds` beside the titles. `tests/store-link-purpose.test.ts` now finds the vague link's name in its fix link.

## Criteria
- AX274 Part A item 6 (each warning offers its fix in one click; the creator's content never changed without approval); ATAG 2.0 B.3.1; WCAG 2.2 2.4.3, 2.4.9 for the links themselves, 2.5.5 (44 px).

## Proof
- RED: `tests/store-access-fix-links.test.ts` (real store over the Redis stub, the drawn warning, both editors' wiring, the hook in Chromium from the keyboard): 7 of 7 fail on main; 11 of 11 after. Store-check, link-purpose, link and product editor, product image, inventory, tap-target and US-English tests pass; `tsc` clean.

## Accessibility
- Checked: nothing opens before the press; Enter on the link puts the focus in the empty description field and writes nothing; an item not held is left alone.
- Steps and decisions for the main task: one press to reach the field instead of finding the product in the list and opening it.
- Not checked: real assistive technology, testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3, snapshot 13 Nov 2026 23:15 UTC-3)
- #3530, #3534, #3537, #3556, #3558, #4130: `components/product-editor.tsx` 96 (imports).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
