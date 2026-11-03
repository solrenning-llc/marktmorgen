630 [HN6](39): a partnership (a partner's share of a product) runs to a date the creator chooses or until either side ends it; once agreed, the creator cannot change it alone; every step is in a history.

- **Unit 1** (`lib/partner-terms-rules.ts`, `lib/partner-share.ts`): an optional end (`until`) on a share, read at each sale's own time, so a sale paid on or after the end earns nothing; the rules for which changes wait for the partner's yes (all, except ending a share that runs until revoked), the 30-day wait, and a capped history in plain US English.
- **Unit 2** (`lib/affiliates.ts`): `proposePartnerShare` and `answerShareChange` keep the waiting change and the history on the partner's record; a yes is checked against the cap again; an unanswered change lapses; saving the share in force withdraws a waiting change; an accepted invitation starts the history.
- **Unit 3**: the studio's share action uses it (optional "Last day it earns"; "Waiting for their yes"; "History of this partnership"); the partner answers on their own affiliate page through a new form route (`app/api/store/affiliates/partner-answer`, a public-request limit per partner), in the store's seven languages. The cap now leaves out shares that ended, through one helper shared with invitations.
- **Unit 4**: the invite form takes an optional last day too; the invitation email (and the offer a creator already here reads in their studio) says "It runs through …" or that it runs until either side ends it, in the store's language, so the partner agrees to the end by opening it.

Nothing already earned moves. No price, limit, commission, flag or gate changed; no money moves (the creator still pays partners from their own PayPal).

## Tests
`tests/partner-terms.test.ts` (7), `tests/partner-terms-kept.test.ts` (21), `tests/partner-terms-wired.test.ts` (34, real routes, synthetic store, a stand-in email service for the invitation), `tests/partner-share.test.ts` (26), and every affiliate/partner test; accessibility inventory regenerated; typecheck, lint, public data, US English.

## Acessibilidade
- Criteria checked: 1.3.1 and 4.1.2 (the date field and the answer buttons are native, labelled controls; the help text is tied with `aria-describedby`); 4.1.3 (the waiting notice and the answer result are `role="status"`); 2.5.5 (buttons and the history summary keep 44 px targets: `btn`, `min-h-11`); 3.3.6 (a change waits for the other side and can be taken back; nothing earned is touched); 3.1.5 (plain words in each language; dates written out); 2.4.6 (section label kept; "History of this partnership" in a `details` summary).
- Method: reading the markup in the diff and the source assertions in the tests. No screen reader or browser run.
- Not covered: contrast and forced-colors were not measured (only existing classes are used); no test with people (item 202).
- Steps/decisions for the main task (change a partner's share): 1 → 1 save for the creator, plus 1 answer for the partner, which is the point of the item.

## VR
State: tested in a PR. The partner-answer page works only where a creator has partners; nothing is shown that does not work.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
