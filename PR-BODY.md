## Summary

AX274 Part A, WCAG 2.4.7 Focus Visible (AA) and 2.4.13 Focus Appearance (AAA). Found on a seeded local build (/studio/course/<product> with a lesson open, 1280 px): "Upload a video", "Add a download", "Add captions" and "Add lessons from videos" are labels drawn as buttons around, or beside, a file field kept visually hidden (`sr-only`). The Tab key stops on the hidden field; its own 3 px ring is clipped to one pixel and the label shows nothing, so a keyboard user cannot see where the focus is. The same pattern is in the look editor, the email picture button and the funnel-share file picker (7 fields in all).

One rule in `app/globals.css` draws the same ring as every other control (3 px `var(--focus)`, offset 3 px) on the label that is seen, whether it wraps the field, comes just before it or just after it. No component changes.

## RED → GREEN

- `tests/file-input-focus-ring.test.ts`: RED on main (3 of 5 checks fail: the three selectors are missing); GREEN with the rule. It also fails if a new hidden file field in the tab order has no wrapping or neighbouring label for the ring.
- Tests that read `app/globals.css` (42 files): all pass.

## Acessibilidade

- Criteria checked: 2.4.7 Focus Visible, 2.4.13 Focus Appearance (3 px outline, same token as the site's own focus ring), 1.4.11 contrast of the ring (same `--focus` token as the global rule).
- Method: seeded local build (tests/e2e seed plus the editors seed), Chromium via Playwright, Tab walk until the active element is a file field, then the computed outline of its label and a screenshot; static test over every `.tsx` in `components/` and `app/`.
- Results: before, the label's outline was `none` and the screenshot showed no ring; after, see the verification in this branch's commit message.
- Not checked: Windows High Contrast with a real screen reader; Safari and Firefox (the rule uses `:has()`, supported in current Safari, Firefox and Chromium); hidden file fields with `tabIndex={-1}` are out of the tab order and need no ring. Automated checks do not certify conformity.
- Steps and decisions of the main task: unchanged (0 → 0).
