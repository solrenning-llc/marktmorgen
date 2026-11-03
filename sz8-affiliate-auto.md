624 [SZ8](35): an optional "Approve every application at once" in the affiliate program's terms. Off by default and for every program saved before.

- On, a new applicant is approved through the same `decide` path as by hand, so the approval email with their link goes as usual; the creator is told who joined and can remove them at any time.
- Someone the creator declined or removed stays out.
- No price, limit, commission, flag or gate changed. The email to the approved affiliate is the store's existing one, counted as before.

This PR waited for #1802 (merged 03/11) and was rebased on main.

## Tests
`tests/affiliate-auto-approve.test.ts` (6), plus the affiliate tests; accessibility inventory, US English, typecheck, public data.

## Acessibilidade
- Criteria checked: 1.3.1 and 4.1.2 (a native checkbox inside its label, the label holds the name and the explanation); 2.5.5 (the label is the target, at least 44 px high); 3.1.5 (plain words that say what happens on and off); 3.3.6 (removal stays possible at any time).
- Method: diff reading and the test's source checks; no screen reader or browser run.
- Not covered: contrast and forced-colors not measured (existing classes only); no test with people (item 202).
- Steps/decisions for the main task (let affiliates join): before, one approval per applicant; after, one choice once.

## VR
State: tested in a PR. Off unless the creator switches it on.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
