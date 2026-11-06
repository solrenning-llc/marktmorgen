# API read decisions — C4-2630 evidence only

Base: `849cef1d131c8fc70e2061e8865b80a1571437ec` (main, 2026-11-06).
Reservation: coordination commit `991e87ca0f0f3b73edd7e7fbfd17349983b253ba`, before proof files.
Only three new opt-in evidence files. No production/configuration/reservation/CI edit.

## Reproduce

```sh
TMPDIR=/dev/shm node proofs/c2/api-read-decision.mjs
TMPDIR=/dev/shm node proofs/c2/api-read-decision.mjs --linked
```

The original command deliberately exited 1 with **19 checks, 11 causal failures,
8 passing controls**. The C4-assigned implementation reservation then added the
PayPal sibling without changing the original assertions: the same command now
exits 1 with **24 checks, 14 causal failures, 10 passing controls**.
The second runs seven existing suites with their canonical aliases: **264/264**
(cart19, cart-physical28, digital-consent93, preorders31, waitlist32, assignments51,
task-room-unknown10). Initial fixture errors (Request without NextRequest cookies;
attaching a course to a product already delivering a link) were corrected before
these results. They are not product RED evidence.

## Proven case A — unknown coming-soon state permits ordinary checkout

| Boundary | Unknown result | Observed consequence |
| --- | --- | --- |
| `app/api/store/cart/route.ts:282` → real `soonState` | exception, `[null, []]`, or `[]` | one real checkout-writer POST to synthetic Stripe per case; 303 to its checkout URL; `metadata[cart]=yes`; no preorder metadata |
| `app/api/store/checkout/route.ts:163` → real `soonOne` | exception, `[null, null]`, or `[]` | one real checkout-writer POST to synthetic Stripe per case; 303 to its checkout URL; no preorder metadata |
| `app/api/store/paypal/checkout/route.ts:50` → real `isSoon` | exception, `[null]`, or `[]` | one real order-writer POST to synthetic PayPal per case; 303 to its approval URL |

Every affected fixture was first marked coming soon by the real `setSoon` writer.
With a valid reply, the same routes refuse checkout (cart=changed / #waitlist).
With a confirmed empty set, each opens exactly one checkout/order, preserving
the positive controls. In all nine failing cases the one read is intercepted at
the MemoryRedis pipeline, not by replacing the reader or checkout/order writer.

The route catch maps rejection to `soon:false` / an empty set. Additionally,
`lib/preorders.ts:64–74` accepts a short envelope or null members as not coming
soon; merely removing the route catch does not cover malformed successful replies.
Cart's product-count check at :283 correctly refuses a missing product; it does
not protect the independent pre-sale state.

This proves unauthorized *ordinary checkout/order creation* for a pre-sale
fixture, not an actual charge, completed payment, customer loss, or remote
exploit against the provider transport. No provider was contacted. Existing
plan and payment gates are not changed or certified by this proof. Claude 4
assigns severity/owner.

Ownership conflicts observed in the 140-open-PR audit: cart is occupied by
#1730/#1928 and the stacked #1969; checkout by #2832 (page-display scope) and
other previously announced claims. No product branch was edited.

## Proven case B — a failed file read consumes the upload receipt

`app/api/store/course/task/route.ts:81–83` calls the real `takeTaskUpload` before
`headFile(path).catch(() => null)`. `takeTaskUpload` removes the path from
`nl:tasks:doors`. The file-store HEAD then throws in the synthetic provider.

Observed actual route sequence:

1. A real enrolled learner, real course/task, real learner pass and a real
   `noteTaskUpload` receipt are set up with MemoryRedis. The provider fixture holds
   the uploaded file; the upload's ZSCORE is present.
2. The provider HEAD fails once. Route returns **400 missing**, despite the file
   remaining present. The existing upload door is gone; no submission was saved.
3. Restore the provider and submit the same file again: **400 invalid**, before
   any HEAD; there is still no submission.
4. In a separate equivalent failed-read fixture, advance only the sweep's time
   argument beyond the normal upload lifetime: real `staleTaskUploads` returns
   `[]` while the provider fixture still holds the file. A healthy unused-upload
   control is found by that same sweep.

Five assertions fail (honest transient result, successful retry, saved file,
preserved door, cleanup discoverability). Four controls for this family pass:
healthy hand-in, initial door exists, original file is not deleted, and healthy
unused-upload cleanup. This is one failure chain, not five separate defects.
The file remains under its store folder; the proof does not claim it can never
be removed by a separate full-store deletion/inventory mechanism.

This route is occupied by #2608. `lib/assignment.ts` is shared and has other
coordinated work. No source or other agent branch was edited. Claude 4 assigns
severity and ownership.

## Rule 30 triage — not additional proven findings

- `app/api/billing/checkout/route.ts:102`: accountStores failure becomes `[]`
  before funding/checkout. Not proven harmful here; no money/flag/policy experiment.
- `app/api/store/kit/route.ts:53` and numbers-links:40: readVerified failure can
  initiate refresh. Not proved as an uncapped spend or invalid write here.
- `app/api/store/agreements/route.ts:32`: failed request lookup yields refusal;
  no write consequence demonstrated. Not reported as a finding.
- `app/api/cron/courses/route.ts:39`: failed stale-upload scan defers deletion;
  no new destructive action demonstrated. Separate from case B's consumed receipt.
- Form/body parsing catches that return 400, authentication catches that refuse,
  optional attribution, display-only readers, and cleanup write catches are not
  automatically findings. The grep inventory is triage, not a completeness claim.
- page, page-versions, site-page and saved-blocks were excluded as instructed.
  No duplicated proof/implementation of A/B/B2, blog, forms or mail drafts.

## Validation and limits

Directed strict TypeScript for the proof and its real imports: 0 diagnostics.
Focused ESLint and launcher syntax: 0 errors. Public-data scanner and diff are
recorded in the publication message after the report is indexed.

Real route/reader/checkout writer/assignment writer code; canonical MemoryRedis,
synthetic Stripe and PayPal fetches, synthetic file store, next/headers request fixture and
next/server after fixture (after callbacks held) are explicit. No native Redis,
browser/production deployment, real provider, email delivery, actual charge,
paid IO or global CI/TSC certification. No global alias or product modification.
Unknown costs are not certified as zero. These are blocking regression proofs,
not a fix or a product PR.
