# Independent review of #2968: outreach stop feedback

Reviewed head: `71aa538e0ee928e8d561905b042810c33136ba7f`, tree `80f4eed32a6e23da8d2e85ac51a7a182621d56de`. Claim preceded source/diff/tests: PR comment `6697604313` and channel commit `3517968c0a5f4e5d60e4547e9f84526a445b8712`. The PR was OPEN/non-draft with no prior review or claim when nominated. This report does not certify current hosted checks or merge readiness.

The advertised base was `8f73f9d31b1cc912bb127ce9259601d739732981`; the actual merge base is `5c07315505e1d53ee6401021601cd688fa98ecda`. The complete three-dot PR diff has exactly two paths: the stop page and its new author test. A direct two-dot comparison also shows unrelated main-only work; those differences were excluded, not attributed to this author or reviewed as part of this PR.

## MEDIUM: the unread branch still removes both stop actions

At `app/outreach/stop/[token]/page.tsx:36`, the new unread branch renders a heading and status paragraph but neither stop form. The PR's explicit contract is that a failed read must not take away the stop buttons. Changing the missing-link statement repairs the wording, but does not complete that behavior.

The strongest causal case is a healthy, confirmed stop-link GET followed by a transport exception only in the two-SISMEMBER stop-state read. The real page/helper/MemoryRedis render zero stop forms. Under that exact selected state-read failure, the real `stopFromLink(token, false)` still follows its GET/HGET/SADD path, returns true and records the synthetic store stop. Thus the read failure hides an action that can actually complete. The same page also hides both actions on a selected link-GET exception.

This is a conditional incomplete repair of the existing behavior, not a claim of a new regression or of emails being sent. The standalone independent proof executes the reviewed head, not a fabricated fixed product. The original author RED replay below establishes the wording repair; it is not relabeled as a new baseline execution of all forty independent checks.

Requested correction: retain the explicit store/all stop controls for a usable token in the unread state, with generic wording when the owner cannot be read, while preserving zero render writes and avoiding a false claim that a stop already holds. The existing POST/helper revalidates the token. Preserve both causal cases as permanent regressions, retain healthy/missing/invalid/stopped controls, and request a focal return on the corrective delta.

## Actual independent evidence

`tests/k-review-2968-outreach-stop.proof.ts` uses the real page, real `readStopLink`, real `stopFromLink` and canonical MemoryRedis fixture. It injects only the selected pipeline read response/exception. No substitute page/helper implementation or product fix was supplied.

Result: **40 checks, two causal failures and 38 controls passing**. The failed expectations require both explicit stop scopes to remain actionable on the two transport exceptions.

| State | Actual stop scopes | Other observed controls |
| --- | --- | --- |
| Healthy link, not stopped | all, store | Original token carried; no render write |
| Confirmed missing link | none | Missing-link state retained |
| Invalid token | none | No storage command dispatched |
| Link GET throws | none; expected all, store | Unread wording; no missing-link or positive-stop claim |
| Known link, stop-state SISMEMBER throws | none; expected all, store | Real stop action returns true and synthetic stop membership becomes 1 |
| Known link, unknown stop-state replies | all, store | Existing helper keeps both controls |
| Confirmed store stop | all | Token preserved |
| Confirmed global stop | none | No unnecessary action |

Every page render writes nothing. The proof admits commands before each application batch, at most 40 per scenario and 320 total. Actual application dispatches were 20, including the three-command synthetic stop action. Fixture setup used nine further commands and the direct membership observation used one: **30 synthetic commands overall**, with setup/observation explicitly outside the application counter. No actual provider operation was attempted. The synthetic SADD is a local test action, not a message or outside contact.

The exact author test blob `0ef8718c68eaa2661d93a31793d809aed9fca7bf` is identical in RED `1cea90eeab946e6c6a04b2596fa0ec93d882600b` and the reviewed head. Its exact RED page preimage, blob `cfb99e88c37d0ca04653f54de20ad987f97c6c78`, was supplied as the only page overlay; the remaining source closure is unchanged by the two-path PR. The same four author checks produce two failures against that preimage and 4/4 passes against the final page. The author test checks wording and a healthy heading, but does not assert the two stop forms in the error state.

The existing related `outreach.test.ts` passes **145/145** once. Its canonical fixtures intercept provider requests; no actual outside service was called. The related run counts all 552 synthetic Redis commands, including its setup and observations, under a 10,000-command ceiling admitted before dispatch. No unrelated suite was run.

## Source, checks and reproduction

The source is a complete detached checkout of the exact reviewed head, with own installed dependencies linked separately. The independent executable and runner are the only new executable evidence paths. No author file, remote ref, PR or CI job was changed.

| Path | Exact reviewed blob |
| --- | --- |
| `app/outreach/stop/[token]/page.tsx` | `8b93d6eb2f0daba141c31a07292f9be3392e121d` |
| `tests/honest-outreach-stop.test.ts` | `0ef8718c68eaa2661d93a31793d809aed9fca7bf` |
| `lib/outreach.ts` | `53e1e8b985cd703ab95610e8cda31ca00fceb785` |
| `tsconfig.json` | `f126992ca95c6da5359e547a2e58e92fccd3d02c` |
| `tests/test-config.mjs` | `46ddad8f5d5225f6b0e9b22d63310255ba652090` |
| `tests/run.mjs` | `13c4470bb862b816d88a449469980857a17ace7b` |

Reproduce from the evidence checkout, using an exact source checkout whose Git object database includes the author RED:

```sh
timeout 120s node proofs/k2/review-2968-outreach-stop.mjs /absolute/exact-source
```

The runner pins the source/helper/test/config identities, preserves the four author expectations and all forty independent assertions, and expects the independently demonstrated two-failure result. A zero runner exit means that expected evidence was reproduced, not that the product passed the forty checks. The test file itself exits nonzero on the two causal failures. Runtime is bounded to 120 seconds with a 128-KiB combined-log admission; the successful evidence run emitted 6,057 bytes. The related execution emitted 7,399 bytes under its separate 120-second/128-KiB bound. Node 24.22.1 was used.

An initial temporary preimage mount could not resolve `next/link` before any test executed. Supplying the actual source node_modules resolution path and exact tsconfig corrected the evidence mount; this setup failure is excluded from product findings and RED counts.

Actual scoped TypeScript over the page, author test and independent proof roots, with their real imports and repository ES2017 configuration, reports zero diagnostics. Directed ESLint passes on the two author paths and the two own executable paths. Native three-dot source `git diff --check` passes. The public-data detector reports five paths and zero corrections over the two author paths and all three own evidence/report paths.

## Design and limits

The new heading and `role="status"` paragraph correctly distinguish unread data from a missing link. SSR confirms those elements, but does not prove an announcement by a screen reader. The lost action controls are the demonstrated functional/accessibility issue. No browser, assistive technology, contrast, AAA or complete journey validation is asserted.

The head does not include the separate #2870 `readLink` repair. Its permissive handling of malformed stored link payloads is not attributed to this two-path PR, overlaid as a fix, or claimed tested with that future dependency. Full backend outage, future integration of that helper, hosted CI, full production build, native Redis and actual provider delivery are outside this execution. No money, margin or general cost-model certification is made.
