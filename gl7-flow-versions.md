639 [GL7](19): a workflow's earlier versions, and putting one back, as sales pages already have.

- **Unit 1** (`lib/flow-versions.ts`): each save that changes what a workflow does keeps the version before it (the newest ten, newest first, under `nl:wf:ver:<listId>:<flowId>`, counted in the store's data room in slot `wv:<flowId>`; a full room keeps none and never stops the save). Switching on or off keeps none. The mail route lists them (`flow-versions`) and puts one back (`flow-restore`): an ordinary `saveFlow` of that content, checked whole against the store as it is now, keeping on/off, and keeping the version it replaced so it can be undone. A removed workflow's versions go with it. Registered in `lib/data-families.ts` (counted, erased on closing) and `tests/store-data-registry.ts`.
- **Unit 2** (`components/workflow-versions.tsx`): "Earlier versions" beside "Runs" in the email studio; each version with "Put this version back"; it says what is kept, that on/off stays, and what happens to people already in the workflow (same step number; a run past the last step ends, as when a step is removed).

No new supplier, no email sent, no price, limit, commission, flag or gate changed.

## Tests
`tests/flow-versions.test.ts` (18: real mail route, synthetic store), plus data-recount, store-data-registry, closed-store, closing-families, person-copy, flow-actions, mail-response, accessibility inventory and statement, US English; typecheck, lint, public data.

## Acessibilidade
- Criteria checked: 1.3.1 and 2.4.6 (a named section, `h4` with `aria-labelledby`); 4.1.2 (the toggle is a button with `aria-expanded`); 2.5.3 (each button's accessible name starts with its visible words, then the date); 4.1.3 (loading and result in `role="status"`, errors in `role="alert"`); 3.3.6 (putting a version back can be undone the same way; nothing is lost); 3.1.5 (plain words, dates written out); 2.5.5 (buttons use `btn btn-sm`, 44 px).
- Method: markup rendered with `renderToStaticMarkup` in the test and read in the diff; no screen reader or browser run.
- Not covered: contrast and forced-colors were not measured (existing classes only); no test with people (item 202).
- Steps/decisions for the main task (go back to an earlier workflow): before, retype it by hand; after, 2 clicks (open, put back) and 1 decision.

## VR
State: tested in a PR. Shown only beside saved workflows; it works for each one.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
