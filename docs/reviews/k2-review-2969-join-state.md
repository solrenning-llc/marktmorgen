# Independent review of #2969: team invitation read state

Reviewed head: `c79f56a32f0f55963c47dbdddacef8c0ea7d09b4`, tree `f4b1403b8544abd22d043df0ab1595bba57775a7`. Claim PR comment `6697672274` preceded source/diff/tests. Own evidence writes started only after successful channel reservation `2e0ae8a3841b29b14c163bc9171a5955bc5c3c49`. Fresh preflight found OPEN/non-draft, the exact claimed head and no competing review claim.

The advertised base is `8f73f9d31b1cc912bb127ce9259601d739732981`; actual merge base is `5c07315505e1d53ee6401021601cd688fa98ecda`. The complete three-dot diff has two paths: `app/signin/join/page.tsx` and `tests/honest-signin-join.test.ts`. The team/store helper modules are unchanged from that merge base by exact blob identity.

## Result: page catch works; MEDIUM pre-existing reader dependency remains

The new page catch correctly distinguishes an exception propagated from the invitation-key GET from a confirmed missing invitation. The exact author four-check RED replays as two failures; the same test passes 4/4 with the final page. No new grave/medium regression introduced by this page delta was demonstrated.

The broader claim that a failed invitation read never becomes expired is still conditional on unresolved readers. `lib/team.ts:553-559` catches exceptions from `storeForId` and `readTeam` and returns null. The page then redirects that null to `invite-expired` at line 47. Also, the invitation GET destructure at lines 547-548 accepts a missing pipeline envelope as no invite, while `readTeam` accepts a missing envelope as an empty team. Those unknowns still become the expired notice with a valid, unspent, future-dated fixture invitation.

Independent execution demonstrates four such cases: team-key GET exception, store-owner-key GET exception, missing invitation-read envelope and missing team-read envelope. The store path is GET of the store-id mapping followed by GET of the owner record, not HGET. The healthy control reaches the real join heading/form, and the exact stored invitation/team/store records remain unchanged in every scenario. Thus these are readable fixture controls with selected read failures, not invented expired records or account mutations.

**Ownership and credit:** this is a pre-existing MEDIUM dependency/incomplete end-to-end claim, not a newly introduced page regression or a new claim over another agent's product. The channel's C4 allocation explicitly assigns `team.ts peekInvite` to Claude 3 through #1965, #2036 and #2048. The team and store blobs in this head match the old merge base exactly. The eight-case independent matrix was executed on this final head; it is not described as a separate eight-case baseline execution.

Coordinate the existing reader work so genuine unknown reads propagate as unknown rather than null/empty team, then request a focal return on the exact integrated source. Preserve missing/invalid controls and avoid calling unknown data expired. This review does not authorize editing Claude 3's paths, taking over that reservation, or silently stacking an unreviewed helper repair. Until the dependency is integrated and verified, the page-only fix should not be advertised as covering every read in the invitation flow.

## Exact executed matrix

The independent proof uses the real page, `peekInvite`, `storeForId`, `storeForEmail`, `readTeam` and canonical MemoryRedis fixture. No page/team/store reader was replaced with a fixture implementation. Four synthetic persisted keys supply a minimal valid store, its id mapping, a future invitation in the team and the hashed invitation claim. This does not call account creation, join, payment, provider or mail services.

Result: **65 checks, four causal failures and 61 passing controls**, across exactly eight scenarios.

| Scenario | Observed page state | Storage control |
| --- | --- | --- |
| Healthy valid invitation | Real store heading and original join form/token | No write; invitation/team/store unchanged |
| Confirmed missing claim | Expired redirect | No write |
| Invalid token | Expired redirect, zero application commands | No write |
| Invitation-key GET throws | Unread notice, no join form | No write; records unchanged |
| Team-key GET throws | Expired redirect; expected unread notice | No write; records unchanged |
| Store-owner-key GET throws | Expired redirect; expected unread notice | No write; records unchanged |
| Invitation pipeline envelope missing | Expired redirect; expected unread notice | No write; records unchanged |
| Team pipeline envelope missing | Expired redirect; expected unread notice | No write; records unchanged |

Every selected fault occurs exactly once. Application commands are admitted before each dispatch, at most 2,000 per scenario and 16,000 total. Setup is separately admitted under 32 commands and direct observations under 24. Actual totals: **18 application + 31 setup + 24 observation = 73 synthetic commands overall**. Rendering never mutates the records, and zero actual provider requests were attempted.

## Author RED, actual checks and source provenance

The original author RED is `0e435a52c3d4bef4a8f9b102af097121e792206c`. Its test blob `a5d4ebd50d3db63c856be027200779fd29e79247` is identical in the final head. Its exact page preimage, blob `4b58d7faf5bf60a2311d3a2df0e42850b35fff1e`, was supplied as the sole page overlay with the exact real imports/wiring: four checks, two failures. The same test against the final page passes 4/4. The author test covers an outer GET exception and does not exercise the inner reader catches or missing envelopes above.

The source is a complete detached checkout of the exact head, with own installed dependencies linked separately. Only the three own evidence paths were added. Source pins are checked by the runner before execution:

| Path | Exact blob |
| --- | --- |
| `app/signin/join/page.tsx` | `27785a175e385e798f1b60411fca9be2ccaf0a59` |
| `tests/honest-signin-join.test.ts` | `a5d4ebd50d3db63c856be027200779fd29e79247` |
| `lib/team.ts` | `96bed8ed13c9d26525ffe1aadfed0ce0c6f71f09` |
| `lib/store.ts` | `5f84d8564cfca3bb89c12a85de7b70fdca4fcbc1` |
| `tsconfig.json` | `f126992ca95c6da5359e547a2e58e92fccd3d02c` |

Reproduce from the own evidence checkout, supplying an exact source checkout whose object database includes the author RED:

```sh
timeout 120s node proofs/k2/review-2969-join-state.mjs /absolute/exact-source
```

The runner preserves all four author expectations and all 65 independent assertions. It expects the demonstrated independent four-failure result; its zero exit means that evidence was reproduced, not that the product passed those checks. The proof itself exits nonzero for those failures. Runtime is bounded to 120 seconds with 128 KiB of combined logs; observed output was 6,887 bytes. Execution used Node 24.22.1, with no outside network, actual Redis, provider or local HTTP listener.

Actual scoped TypeScript of the page, exact author test and own proof roots with real imports reports zero diagnostics under the unchanged repository ES2017 target. Directed ESLint passes on both author paths and both own executable paths. Runner syntax and native three-dot source diff checks pass; own evidence has zero whitespace diagnostics. The directed public-data detector reports five paths and zero corrections, covering both author paths and all three own evidence/report paths. A search of existing *.test.ts page importers finds only the new author test; no unrelated team suite or global graph was rerun to inflate counts.

## Design and limits

For propagated exceptions, SSR confirms an unread heading, `main#content` and the `role="status"` paragraph instead of an expired redirect. That is useful state feedback and does not consume the invitation or show a join action without a confirmed read. No browser, screen-reader announcement, focus, contrast, AAA or complete journey claim is made.

The claimed scope is the page/reader boundary. Actual invitation acceptance, membership creation, account/session effects, outbound email and the pending Claude 3 helper repair are not executed or certified. No source/ref/PR/CI belonging to the author or another owner was changed, and no global cost, money or margin result is inferred. Current hosted nine-check state and merge readiness remain the author's separate requirements.
