## Summary

AX274 Part A, WCAG 2.5.5 Target Size (Enhanced, AAA). Found on a seeded local build (/studio/course/<product>, a lesson's quiz open, 1280 and 320 px): the circle or box that marks an answer as right ("Answer 1 is right") measured 20 × 20 px and had no label around it, so nothing larger could be clicked or tapped. It now sits in a 44 × 44 px label that ticks it too; the field keeps its own name (`aria-label`), so what a screen reader says is unchanged.

A scan of every `.tsx` found no other radio or checkbox named only by `aria-label` outside a label; the new test keeps it that way.

## RED → GREEN

- `tests/quiz-answer-target.test.ts`: RED on main (4 of 6 checks fail); GREEN with the label.
- The other tests that read `components/quiz-editor.tsx` (6 files, including `quiz-editor-target-size.test.ts` and `quiz-add-focus.test.ts`): all pass.

## Acessibilidade

- Criteria checked: 2.5.5 Target Size (Enhanced), 2.5.8 Target Size (Minimum), 4.1.2 Name, Role, Value (name unchanged), 2.4.7 focus ring (still on the field itself).
- Method: seeded local build (tests/e2e seed plus the editors seed with a two-question quiz), Chromium via Playwright at 1280 and 320 px, bounding boxes of every control, axe-core (wcag2a/aa/aaa, wcag21, wcag22aa, best-practice) and a forced-colors pass.
- Results: before, 6 right-answer marks at 20 × 20 px; after, see the verification in this branch's commit message. No axe violations before or after.
- Not checked: real touch devices and screen readers. Automated checks do not certify conformity.
- Steps and decisions of the main task: unchanged (0 → 0).
