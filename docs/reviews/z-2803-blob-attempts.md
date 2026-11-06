# Independent Blob request-shape probe for PR 2803

Target: `849a875c972f2730d31703989ded236c70a93447`.
Reservation: channel `47de7063b8342c7c701c9e8e29803d8def1503be`, before code. Only these three new evidence paths belong to this branch; the author's source, tests, branch and CI are untouched.

## Conclusion

**No demonstrated MR funding deficit in these cases.** The SDK can send more advanced operations than the isolated `BLOB_PUT_TRIES` component, but the WHOLE registered request budget covers all four measured upload scenarios. The deliberately failing component-only hypothesis is preserved, not promoted to a material finding and not substituted for a failing whole-cost assertion.

| Actual client mode | Studio units | Application upload requests | Advanced attempts | Upload cost upper bound | Whole request budget |
| --- | --- | --- | --- | --- | --- |
| Single, healthy | 1 | 1 | 1 | 0.0000094 USD | 0.000269 USD |
| Multipart, healthy | 1 | 1 | 3 | 0.0000194 USD | 0.000269 USD |
| Single, ten retries | 1 | 1 | 11 | 0.0000594 USD | 0.000269 USD |
| Multipart, ten retries at each stage | 1 | 1 | 33 | 0.0001694 USD | 0.000269 USD |

The upload upper bound is observed advanced attempts at the registry's advanced-operation rate plus ELEVEN name HEAD attempts at its simple-operation rate. The fixture's name check itself reports a missing file once; eleven is a conservative SDK bound, not eleven observed HEADs. No GET/attach happens in these requests. The registry also reserves two complete 1 MB reads and all name/picture HEADs for EVERY studio request. That conservative combined allocation funds the multipart envelope here even though its advanced component alone is eleven.

This does **not** prove every adversarial reuse of a signed URL, arbitrary multipart lifecycle, all other Blob callers, real billing or whole-company margin. Review-photo and mail-picture accounting remain separately reported legacy gaps; Claude 5 already requested assignment. It does not certify them free or solved.

## Method and unchanged assertions

`TMPDIR=/dev/shm node tests/z2803-blob-attempts-run.mjs [source-checkout]`

Actual `uploadPresigned`, `handleUploadPresigned`, SDK signing/multipart/requestApi/async-retry, image upload route, origin guard, auth/session, studio admission and MemoryRedis execute. The only boundaries replaced are Redis transport and Blob network/signing response: synthetic delegation/signing material and synthetic 503 responses, with no real credentials, account, provider, URL fetch or payment. Auth/allowance replies are not fabricated. A new route request is made for each case, using a real synthetic store/product/session. The request's `multipart` flag is accepted by the existing route.

Real async-retry selects attempts and respects its default ten extra tries. Node's isolated timer mock advances only setTimeout backoff; Date, quotas, assertions and production timeouts are not increased. Each stage responds with ten transient failures then a successful fixture response. A finite 200-tick harness bound must settle. Single healthy and single retry controls prevent a fabricated universal multiplier. JPEG content type and the existing test JPEG prefix are used; this is an upload test, not image decoding/attachment certification.

Result: FOUR scenarios, THREE fully passing and ONE deliberately red isolated-component probe; **all FOUR whole-request funding assertions pass**. There is no RED funding regression to fix. Keep that distinction when reproducing this evidence. The original component assertion remains in place.

Preliminary harness failures are not product findings: an Origin mismatched the test application's configured origin (corrected to the existing same-origin Sec-Fetch-Site fixture); the initial mock allowed the old Blob hostname but the installed SDK uses vercel.com/api/blob (corrected to its actual API host). TypeScript fixes normalize nullable RequestInit.signal and use the supported Buffer body. These changes happened before durable publication; no finding was based on them.

Credit: Revisor 1 found PUT retries and scope wording; Codex S found HEAD retries; Claude 5 implemented both in the target. This probe does not duplicate their fixes. The refunded-first-year model sums ONE worst month plus the annual receiving fee and closing storage; it does not multiply that month's upload cost by twelve.

## Validation

Author's six linked groups on the target: 162 PASS (13 picture-upload-costs, 24 registry, 8 alignment, 77 read ceilings, 39 plan margin, 1 lq17). Strict scoped types, changed-file lint and scanner are recorded with the review; one pre-existing unused-variable lint warning in plan-margin is unchanged. The evidence remains outside automatic product test discovery as `.proof.ts`.

Official primary source read on 6 November 2026: https://vercel.com/docs/vercel-blob/usage-and-pricing (advanced multipart operations, simple metadata operations and client-upload transfer). SDK 2.8.0 source in installed node_modules independently supplies retry and GET behavior. Unknown failed-operation billing is conservatively counted, not set to zero. No claim of a real supplier invoice is made.
