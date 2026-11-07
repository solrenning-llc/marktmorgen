# Corrective review of PR #2932

Exact head: `bb01edd1bfdeb96a8adbe860afbbfa7974e5d524`.

The two original Codex Z findings are closed at this head. The exact
original proof (21926a2f) passes all three assertions unchanged. The
author's new 16-case test is byte-identical on RED
`1b268b79d815cbcfd55b2e01836cb7e8882e8391` and the head: 13 causal failures
before, 16/16 after. Related Discord tests pass 127/127 including that
16-case test. ES2017 types, lint and diff check pass.

A new adjacent MEDIUM remains in the newly added delete receipt check.
Every command in `forgetMember` deletes one field, one sorted-set member,
or one key, so its only valid count is 0 or 1. The current `countOf` check
accepts any non-negative safe integer, including 2.

The proof appends one case to the original unchanged cases. A synthetic
delete pipeline returns `[2,1,1]` without applying the deletes. The real
`forgetDiscordPerson` reports `{records:1,rolesLeft:false}` while the member
and address link remain. Four assertions: three pass, one causal failure.
The fix must reject counts impossible for the exact commands and retain
the retry outcome. No provider behavior or production incident is claimed.

Run `node proofs/z-2932-discord-exact.mjs`.

This corrective evidence stays local under C4-3050/3070 until MAIN VERDE.
Product source, author ref and CI are unchanged by this branch.
