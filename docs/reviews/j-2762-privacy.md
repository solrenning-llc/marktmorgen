# J independent review of #2762

Exact head: dda1a66cd889ec9446eac7e5ae35ba557905a5b3. Claim 8915436e9f77ea36986783ea9083c1f1877e7500 preceded all source/diff/test/proof work. All eight changed paths and their full relevant modules were read; author source/ref/CI remain unchanged.

## MEDIUM: unknown kept-copy read opens the entire member-only letter

Location: lib/letters.ts, publishLetter, the four-command read and `keep` branch (approximately lines 85–109). A republish with omitted products promises to retain the prior restriction and preview. The destructured reply is not checked for cardinality or slot types. If the GET slot is absent/boolean, or the whole pipeline envelope is empty, `kept` remains [], `chosen` is [], and the following SET overwrites the genuine stored member-only copy without products. The real unauthenticated LetterPage then returns the entire body, including material after the preview. No explicit `open:true` or choice to publish to everyone was made.

This unsafe keep fallback already existed in the inherited reader; the PR extends exactly this boundary to retain preview as well. The defect is reproduced on the reviewed head, not attributed as a newly introduced regression. No earlier-head execution of this particular proof is claimed.

Proof uses the real publishLetter/readLetter/LetterPage, real memory Redis and normal aliases. Each mode first stores a legitimate member-only letter with preview2. Exactly one pipeline containing the record GET gets an invalid observation AFTER the actual read; the actual stored copy is unchanged by the fault injection. It then republishes with products omitted, restores the pipeline, reads the actual new copy and renders it for an unauthenticated visitor.

Three invalid modes: missing GET slot, boolean GET slot, empty outer envelope. Each loses product restriction and exposes the private recipe. The intact-envelope control preserves both. The proof retains all53 original author checks and adds8 assertions: **61 checks,6 causal failures,55 passing**, including the two independent intact-response controls. No assertion was removed or weakened. File suffix .proof.ts excludes it from normal suite discovery.

Required correction: exact read envelope and strict slot types before deciding membership/publication or taking data/writing. An unconfirmed prior member restriction is unknown: refuse without replacing the copy or authorizing public access. Keep explicit known absence semantics separate from an unreadable reply. Validate the ZSCORE evidence used for the existing empty-products consent guard too. Run this proof unchanged, the permanent regression and linked tests before another independent review. NOT MAY MERGE while this finding remains open.

## Validation and limits

Original author RED4511f733 reproduced: build rejects the two intentionally missing exports LETTER_PREVIEW_MAX/previewOf. This is a build RED, not53 runtime assertion failures. Final canonical preview53/53; letter-members67/67; letters21/21; mail-body17/17 =158/158.

Strict directed TypeScript including actual imports and J proof: exit0. Changed source/test/config and proof ESLint: exit0. Public-data scanner and diff check passed; exact tracked count in the PR comment. No global TypeScript/full suite, browser, screen reader, native Redis, Stripe/email provider, deployment, legal or global margin certification.

Reproduce: `node scripts/j-review-2762-run.mjs`. It uses testAliases('bv1-letter-preview.test.ts') and testEnvironment unchanged from the repository. All data are synthetic. No author branch, product, flag, limit, price, commission, gate, commercial term, provider, contact or account changed. Unknown cost never becomes zero.

Same-pattern read-only inventory: this module's listLetters maps unknown IDs/raws to empty collections; publishedLetters does not reject odd flat cardinality. These are candidates for the coordinator, not additional confirmed findings or new reservations.
