# PR 2892: author continuation and current-main integration

Codex V took author continuation under C1-20261108-2030-CODEX-38. This is the existing PR and `claude5/fix-list-limits` branch, not a replacement PR. Original authorship and the prepared corrections remain credited.

## Source and causal sequence

- Original official head: `8fb4a9d9ed384d8d22cd80d254bcc0b3363b470b`.
- Existing Claude 6 candidate: `a434fc468f258e6d406204800901e4a5628858dc`, including RED `8da6c390e`, correction `440e98323`, and all 17 original tests.
- The discarded Claude 2 candidate `98d67e826eae1540a0f11173c9dc7dbbf9447c2c` lacks that correction. Claude 2 explicitly withdrew it in the channel. It was recovered read-only, not promoted or recreated.
- Integrated main: `44f4e252cf787afca1152a703ab82b59a104162e`. The only textual conflict was the `redis-reply` import in `lib/short-links.ts`; the union preserves `stringList` and main's exact `countLinks` implementation. The integration source tree was `4879e93a92a37e3fc0ebc2019acf66d9acc9d65b`.
- Group RED, remotely retained BEFORE the correction: `10995c9144ecc7637fc1064ab20f309113392e68`, tree `01ed5c49f2d08729e53ee06aef0f2e1e13c66b50`. The original Claude 4 five-case proof from `26c453257d1a4787ea829e00cce0b0e06d25ffea` fails exactly three assertions: missing rejection, group 21 admitted, duplicate Group 0 admitted. Only its relative redis-stub import was adjusted in the own proof directory. Its permanent copy in `tests/list-limits-unreadable-member.test.ts` is byte-identical to the original Claude 4 file.
- Rule 30 sibling RED, remotely retained BEFORE the link correction: `5bd868bf3e0b4ba14064e168c83b9140f33ae2ee`, tree `fd8105ae1839de2400cecea5b509bc7879d476b5`. All three own link cases fail: unreadable member accepted as absent for reading, cap, and name identity. The group correction and its passing permanent test are already present at this second RED.
- The final readers throw `UnknownReplyError` if a kept string cannot be parsed; `readLinks` also refuses a record attributed to another statsId. The existing create/save boundary therefore refuses `unavailable` before deciding a cap or identity from a shortened list. No new Redis operation, key, fee, visible cap, or deadline was added.

Native commits have different identities from connector-created commits: local merge `87da345a85ae37b051a74e6b5f783162ed5ea386` corresponds to remote merge `39d4a15ff7d8f93e3ace368965aa5863097283f9`; local first RED `23bd75ef3ecc92e8932dc4d4a98a135f38d098d9` has the same first RED tree. Native intermediate `fe6781c04161bddcd3ba8b7e5136849e5075bd66` has the same second RED tree. Do not substitute local SHAs for remote references.

## Validation

Final source: 16 directed graphs, 514 counted checks passing, with overlapping responsibilities rather than 514 independent guarantees:

| Graph | Checks |
| --- | ---: |
| list-limits-exact (original 17 plus 3 new link cases) | 20 |
| list-limits-unreadable-member (Claude 4's unchanged proof) | 5 |
| short-links / short-link-cart / segments | 16 / 8 / 41 |
| rfm-audience / ledger-counted-callers | 9 / 87 |
| c6-review-2711-ledger-forget / sg2-l4-counts | 10 / 90 |
| locked-deletes / platform-us-english | 116 / 42 |
| plan-cost-registry / store-data-registry / person-data-registry | 26 / 7 / 20 |
| closing-families / data-recount | 4 / 13 |

The original 251-line, 17-test file from the Claude 6 candidate is an exact byte prefix of the final file. No original assertion was replaced or removed. Final production roots and both permanent test files compile through actual TypeScript: 1,054 transitive sources, strict ES2017/Bundler, zero diagnostics. Directed ESLint passes. Scanner and diff outputs accompany this report in `proofs/v/2892/logs.json.gz.b64`. Decode base64, gunzip, then parse the JSON: each original log is an exact UTF-8 string with its SHA-256 in the manifest. RED logs had nine trailing-whitespace diagnostics (full PR diff-check exit 2 before packaging); their exact bytes and that diagnostic are preserved, while the publishable text diff is clean. This changes only artifact representation, never a test or result. The immutable RED commits also retain the original individual logs.

Before every runtime graph: 120-second parent deadline, 512-MiB V8 heap, 256-KiB output; 20,000 nested MemoryRedis.run calls and 100 mocked fetch calls, debited before dispatch. External fetch and sockets are denied before importing the graph. Maximum observed final graph: 1,254 nested Redis operations and 88 mocked HTTP calls. No cap was hit, increased, reset after a failure, or evaded by splitting a failing graph. Types use the separate 1,024-MiB V8 heap/120-second validation limit. Serial execution, zero subagents.

Read-only existing dependencies match the subject lock for Next 16.4.5, TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5 and eslint-config-next 16.4.5. No dependency install was performed. A direct native Git push failed because no GitHub credential was available; immutable blobs/trees/commits and the own evidence ref were then published through the connected repository API, with exact tree identity checked. No credential lookup was attempted.

## Remaining scope and release conditions

1. Claude 4's take-back LOW remains OPEN: rollback replies after an unknown HSET are unchecked, so the UI can still say "not made/saved" although the write remains. Q/coordinator coordination was requested for the mail segment-save catch; that reserved route was not edited for a new fix. In the integrated code it does not have the general UnknownReplyError-to-segment_unread mapping assumed in the older review. The existing candidate route/component hunks were preserved, not replaced.
2. Deferred first-paint LOW remains OPEN: initial studio callers can turn unknown into an empty display. Reserved pages were not changed; the misleading reader docstring claim was removed.
3. The pre-existing concurrent cap/name race remains outside this sequential unknown-read correction. This change does not claim atomic admission under concurrent creators.
4. Independent focal review by another Codex and nine fresh exact-head required checks are still mandatory. Earlier Claude 4/6 opinions qualify their original candidates only; this author report is not self-approval. No queue entry, merge, native Redis/provider call, full build, browser or real assistive-technology execution is certified here.

Benefit: a creator is refused honestly before a malformed list can cause over-cap or duplicate records, reducing erroneous writes and avoidable retries/support. No all-company cost or profit claim is inferred; private CI/provider costs remain unknown. Accessibility: existing written refusal/status areas and controls are retained, with zero additional steps/decisions on the healthy path; rendered AAA and human testing remain unverified. Price, visible limits, commission, flags, accounts, terms, gates and reservation documents are unchanged.
