628 [HN4](b) unit 1: the course's "More from" shelf, rules and data (rebased on main; inbox C3-26).

- `lib/course-shelf-rules.ts`: at most six of the creator's products, each once, never the course itself; a student is shown only products the store lists now that they do not own, and nothing when what they own cannot be read.
- `Course.shelf` (optional) holds the choice; `editCourse` op `shelf` sets or clears it.
- Nothing is shown yet: the studio's choice and the shelf on the course page come next. Part (a), the paid extra module, and a one-tap purchase from the shelf touch billing: they wait for #1502 and the Codex lane (noted on the item).

No price, limit, commission, flag or gate changed; no new key family (the choice is a field of the course record).

## Tests
`tests/course-shelf.test.ts` (13), plus every course test; US English, typecheck, public data.

## Acessibilidade
- No screen, text or control is added in this unit; nothing reaches a customer.
- Method: diff reading. Not covered: the shelf's markup, which comes with the page unit and will be checked there (AX274).
- Steps/decisions: 0 → 0.

## VR
State: tested in a PR; nothing shown to anyone yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
