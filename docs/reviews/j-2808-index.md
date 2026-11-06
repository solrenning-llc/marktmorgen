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
