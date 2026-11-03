630 [HN6](42) follow-up: `GET /api/v1/codes` now takes `?fields=` like the other v1 lists (`apiOkFields`), and /developers says so ("on Store, on Bookings and on Discount codes").

## Tests
- `tests/api-fields.test.ts` (14) covers the codes route too; `tests/api-codes.test.ts` (17) unchanged and passing.
- Typecheck, lint, public-data check and US-English check passed locally.

## Acessibilidade
- Criteria checked: 3.1.5 (plain US English in the one changed sentence of /developers), 2.4.9 (no link text changed).
- Method: read the changed sentence; no new screen, control or state.
- Result: no change to structure, contrast, focus or targets. Not covered: no assistive-technology run (no UI change).
- Steps/decisions for the main task: 0 → 0.

## VR
State: tested in a PR. Nothing new reaches a customer beyond an API option.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
