# J review of certificate-copy evidence — 6 November 2026

Exact candidate: 53cd71a18ad6bdcdbc68c3ba0adfb64141c4b89a.
Nominal C4-1855-R-111. Evidence reservation channel87169d894600ed77cc189a94388d039afc0d3f38 preceded proof code.

## MEDIUM residual: invalid certificate IDs become an empty successful privacy copy

lib/certificate.ts:413 and430 discard strings that do not match CERT_ID_PATTERN. The standing HGET value is checked only for string/null, then also silently discarded if invalid. An unknown identity becomes absence, so certificatesOf returns [] instead of throwing UnknownReply. lib/person-copy.ts:265 consumes that successful return and cannot mark the module unread.

Run `node scripts/j-review-2808-index.mjs` on the exact candidate with the evidence files copied in. Result: 24 checks /3 failures /21 passing checks, including three healthy scenarios. SAME bytes against the complete pre-product RED e28066bec5640836318df5676b49bbf1f41e4dc8 give24/3 too: inherited in the touched boundary, not a new regression.

Synthetic valid certificate is stored through actual MemoryRedis SET; by-person and standing indexes use actual SADD/HSET. Only one response slot changes per attack: personal-index SMEMBERS, standing-id HGET, or bounded legacy-index SMEMBERS receives the string `not-a-certificate-id`. Application only performs reads. Every attack reaches exactly one injection, resolves an empty copy, and preserves the original stored certificate. Healthy counterparts return the certificate. Personal/standing scenarios use a real 501-entry all-index to exercise the existing no-legacy-scan branch; legacy case uses one entry. No count, certificate record, quota or provider result is forged. This is helper-level privacy evidence, not a real person's export, an HTTP journey, issued certificate workflow or live Redis account.

Required correction: validate every returned membership ID and nullable standing ID against the existing CERT_ID_PATTERN before using or filtering them. An invalid identity is UnknownReply; preserve confirmed empty arrays and null absence, existing scan ceiling, stored malformed-status export behavior and all other semantics. No new IO or larger ceiling is requested. P owns the corrective product; J did not edit it.

## Existing author correction verified

Full diff: exactly lib/certificate.ts plus tests/certificate-copy-evidence.test.ts. Durable RED e28066be test blobf4a8df0ea88abeb73f1fee42abcfe2ce6bba72af byte-identical to final; all3 node groups fail before and all3 pass after. Nine additional directly linked groups pass:170 custom checks, including certificate-record-evidence30, person-room11, issue17, validity29, share6, look26, PDF6, PDF-ceiling13 and person-erasure32. StrictTS/imports and focal lint pass; scanner3978tracked/0; diffcheck0. Own proof+runner strictTS/lint pass. No ordinary green result closes the residual3 failures.

The existing exact-envelope guards and inert accessor controls work in their tests. replyCount now rejects unsafe counts locally, and certificateCount retains the existing per-course ceiling. This review does not alter or certify forgetCertificatesPerson or global erasure, account/payment/provider behavior, browser/AT, native Redis or hosted CI. No author's branch/ref/CI/reservation is modified.


## Nominal return on ed600617733a50d579561a818b39406d1b2b153d

The original MEDIUM (review5803028737) is CLOSED on this exact head. The SAME unchanged 24-check proof and runner now pass24/24. Proof blobbd0e7a73c155df2d17ebf146534c2474f323006b and runner blobe6ee6386460b6d961264842b9d64c1106ea648c3 were compared byte-for-byte with this evidence branch. Source validates all personal and legacy IDs and the nullable current standing ID before absence/filtering. Confirmed empty/null, existing ceilings and stored-copy semantics remain intact. Linked tests pass3 node groups plus170 custom checks; actual strict TypeScript and focal ESLint exit0; scanner4059 tracked/0 corrections; diffcheck0.

LOW, still open: the new regression is not discovered by CI. tests/run.mjs:24 only discovers filenames ending in .test.ts. The corrective diff adds tests/j-2808-index.proof.ts and an opt-in scripts/j-review-2808-index.mjs, but adds no discovered wrapper, import or CI hook. Actual discovery examined1418 .test.ts files: proofDiscovered=false and importers=[]. The original tests/certificate-copy-evidence.test.ts remains byte-identical (f4a8df0ea88abeb73f1fee42abcfe2ce6bba72af) and contains none of these malformed-ID cases. Therefore the functional fix is verified independently, but ordinary CI would not prevent this regression from returning. Please wire the unchanged proof into a discovered .test.ts group (with its required aliases) or an equivalent permanent test, then request a nominal return on the new exact head. No assertion needs weakening. This is not a clean PODE ENTRAR opinion yet.

No browser, certificate issuance, HTTP export, provider, native Redis or hosted CI was operated. No product, author ref or CI was changed by J.


## CI-discovery nominal return — e3e3ea5af41abe9855e8e66014d5a9f3fe361c30

LOW5803787161 CLOSED on this exact head. The new tests/j-2808-index.test.ts has the SAME original proof blobbd0e7a73c155df2d17ebf146534c2474f323006b as the retained .proof.ts. Actual tests/run.mjs discovery includes the new filename, and running that discovered group through unchanged testAliases/testEnvironment and esbuild passes24/24. Source, original product test, proof and opt-in runner are byte-identical to ed600617. Actual strictTS of the new group and imports, focal lint and diff exit0; scanner4064tracked/0. R2cycle129 independently confirms closure, credited. This is the requested coverage return, not a new global certificate/privacy audit or hosted-CI result. SEM G/M/L in this focal return; PODE ENTRAR only after9NEW exact final SUCCESS checks, fresh clean gates and author's normal expected-SHA merge. No author product/ref/CI or provider/browser operated.
