## Summary

Fixes #4770 (AX274 Part A / 310 [AX2], WCAG 1.4.10 Reflow). In four studio forms drawn as a wrapping row (`flex flex-wrap`), the field's label is `flex-1 min-w-0` beside a submit button. `flex-1` sets a basis of 0, so the row never wraps: at 320 px the field gets only what the button leaves. Measured on a seeded build of main ebeb294b0:
- 31 px for the member's email on /studio/memberships;
- 83 px for the buyer's email on /studio/people;
- 97 px for a share code on /studio/funnels.

Each of those labels now also carries `basis-56` (14rem). The button drops to its own line first and the field takes the whole width; wider screens keep the row as before. The four labels are in `components/member-discount.tsx`, `components/person-find.tsx` and `components/funnel-share-panel.tsx` (the code field, plus the copy-to field, which has the same pattern).

## RED → GREEN

- RED, `tests/squeezed-form-fields.test.ts`: on main it fails, listing the four labels. It reads every `.tsx` and refuses a growing label without a minimum width in a wrapping form row that holds a button (33 such rows found).
- GREEN: 2 of 2 checks pass. The 7 tests that read these components pass. eslint on the four files is clean.

## Acessibilidade

- **Criteria checked:** 1.4.10 Reflow at 320 px; 1.4.4 and 1.4.8 (the label no longer breaks word by word); 2.5.5 (the field is a usable target again).
- **Method:** a seeded local build in Chromium at 320, 390 and 1280 px, measuring every text field's width (under 160 px is flagged), with axe-core (wcag2a/aa/aaa, wcag21, wcag22aa, best-practice) and a check for sideways scroll. Screenshots at 320 px were taken before and after.
- **Results:**
  - Before: 31, 83 and 97 px.
  - After: no field of these forms is under 160 px at any of the three widths, and there is no sideways scroll.
  - axe finds nothing new. /studio/memberships still shows `landmark-unique` and `scrollable-region-focusable` from its tables; those are #4512's.
- **Not checked:** the copy-to field on a real share (it shows only when a share is open; it has the same fix and is held by the static test), real devices, screen readers.
- Automated checks do not certify conformity.
- **Steps and decisions of the main task:** 0 → 0.
