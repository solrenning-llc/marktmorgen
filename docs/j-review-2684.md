# Independent Codex J review of PR #2684

Reviewed head: `bae47bd57924e48c419ddd2b7552d6f3f629af2d`.

The three-file diff and both complete runtime modules were read. The author's unchanged RED `c82e641af` reproduces 10 checks / 7 failures; the final test passes 10/10.

## Findings: not qualified to merge

1. **Medium — unknown query shape becomes known no searches.** In `lib/search-console.ts:166-170`, a numeric row with `keys` absent, null, empty or containing a non-string produces `query: ""` and is filtered out. A response containing only this row therefore returns `[]`; `storeSearches` stores that as a successful reading for 86,400 seconds. The changed function still claims no searches instead of unknown. Require the expected one-query-key shape before constructing/filtering the row, and preserve the unknown response path. Four reproduced failures in `tests/j-2684-shape.proof.ts`.

2. **Medium — unknown managed flag authorizes a Discord role.** In `lib/discord.ts:145`, absent/null/string `managed` becomes false. `serverRoles` passes the normalized role to `assignable`, which allows it below the bot. The studio offers that role, and the product route at `app/api/store/discord/route.ts:52-57` uses the same result to authorize saving it. Thus an unreadable app-managed flag is treated as confirmation that the bot can give the role. Require known boolean evidence, rejecting the malformed role/read; do not default this capability flag to false. Three reproduced failures. Controls confirm valid false is offered and valid true is excluded.

## Reproduction

Run from this proof branch: `node j-review-run.mjs supplier-display-shape.test.ts j-2684-shape.proof.ts discord.test.ts numbers-seven.test.ts`.

- Final author regression: 10/10.
- New proof: 11 checks, four proper controls and seven failing safety expectations.
- Linked Discord: 35/35; numbers-seven: 24/24.
- Directed strict TypeScript for the changed modules, author regression and proof with real imports: exit 0.
- ESLint on those four paths: exit 0.
- Public-data scanner before adding the private proof to the index: 3,799 tracked files, zero corrections.
- Diff whitespace check: exit 0.

Only synthetic HTTP and the repository's standard test aliases were used. No browser, native Redis, actual Google/Discord, provider operation, global typecheck, CI change or foreign product/ref edit was performed. This is not an approval or deployment certification. The author controls corrections and merge after a new qualifying review and nine successful final aggregators.
