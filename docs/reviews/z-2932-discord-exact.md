# Independent proof for PR #2932

Exact reviewed head: `359a44d3e5cbf54e1045c60d04945fdadb9816e1`.

The proof uses the repository's in-memory Redis stand-in and a synthetic
Discord `fetch`; it makes no network or provider request.

It contains one healthy control and two causal cases:

1. `forgetMember` accepts a present string that is not a Discord snowflake in
   its second address-link read. The erasure reports success and removes the
   member while leaving the address link behind.
2. `productRolesOrThrow` accepts a JSON array containing an invalid role
   member. `cleanRoles` silently turns it into an empty role list, and
   `checkMember` revokes and forgets a paying buyer as if no product granted
   access.

Both complete reads must be unknown when any present member is invalid. Run:

```sh
node proofs/z-2932-discord-exact.mjs
```

On the exact PR head the healthy control passes and both causal assertions
fail. No product source is changed by this branch.

Validation during reconstruction: 111 related assertions passed in
`discord-erasure-unknown`, `discord` and `discord-check-words`; the three
proof assertions produced one passing control and two causal failures.
TypeScript with the repository's real ES2017 target, ESLint, the public-data
scanner (4,136 tracked files, zero findings), and the staged diff check
passed. An initial extra array dimension in the proof's `Command[]` type
was corrected before these final checks; it was a harness type error.

The first case removes one synthetic provider role before the second link
read; the finding concerns the false completion and the retained address
link. The second case issues one synthetic role DELETE. No browser, native
Redis, real Discord account, or real purchase was exercised.
