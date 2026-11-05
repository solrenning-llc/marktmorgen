Codex G2 — controller return, exact heads:
- #1949: **2e32f8c20e0892b6e0f3b6343dc75e43773e81fd**
- #1951: **6bd9ebba9a33389e6ff030ea013cb5d7b1df81b3**

**NO RESIDUAL HIGH/MEDIUM in this reviewed delta. My read-completeness suspension (parent6652664848 / child6652744525) is lifted ONLY for these exact corrected heads.** Both may proceed through the normal predecessor order, independent review requirements and nine successful exact-head checks. I do not merge or certify unobserved CI results.

The parent now separates the contracts: readMemoryState refuses a record when not every note was readable; readMemory remains the filtered read-only helper intended for model context. Thus the actual authenticated GET responds503/unreadable for an unknown-only or mixed valid/unknown list instead of returning a shorter complete list. Storage writes still refuse partial records as before. Both helpers perform the same single bounded read as their previous paths; no new provider work, quota, price, flag or activation.

I read the whole corrective13-line parent source delta, the added model/private-read control, and the child permanent proof/inventory delta. Parent and child library blobs are identical: **6bb97a6146cda62a256fc075276610dcf7cbef4e**.

The ORIGINAL six-case proof from98bea9a is byte-identical (**4028cd42462dbccd8232138a9b63f9f75fbe8b57**). Previous full238b51bb:4 controls pass/2 causal completeness failures; current6bd:6/6 pass, no adaptation. Known absence, valid saved note, anonymous access and locked-session refusal remain controls. The author's four-case permanent copy also passes; the new parent test confirms that the filtered helper still returns only the allowed note while the private complete reader refuses the mixed list. No actual model invocation is claimed.

Current independent copies:
- Exact parent2e32:7 linked files,131 numbered checks pass (storage57,evidence8,boundaries5,forget2,rules28,storage registry7,cost registry24).
- Exact child6bd:13 linked files,300 numbered checks pass, including the unchanged original6, permanent-read4, route27, J's identified route4, storage57, evidence8, boundaries5, forget2, rules28, coverage13, registries7/24 and locked-deletes115. J already closed the classification LOW; I ran the required suite without reopening his review.
- Directed strict TypeScript: parent2 roots/imports, child7 roots/imports pass. ESLint0 errors; child has one pre-existing unused GET import in the copied J proof. Public-data scanners parent3702/0 and child3706/0, diff checks pass.
- Exact MEMORY_WRITE and MEMORY_FORGET Lua strings are unchanged from the previously approved36e source. Earlier native v3 protocol evidence remains applicable by identity; I did not claim a new native execution. The earlier quota/expiry/forget fixes remain closed and their current permanent tests pass. The historical raw four-case fixture that requires a new write while the forgetting lock is held is not relabelled as a residual defect.

Durable current-source copy: **codex/g2-review-memory-completeness-return/89ee8008448dcecae527c1c6e92d8df666d65451**, unchanged tests/review-g2-memory-route-read-completeness.test.ts and standalone runner. From root: node scripts/review-g2-memory-completeness.mjs review-g2-memory-route-read-completeness (actually executed6/6). Earlier REDs and withdrawn/superseded reports remain preserved.

No browser, global CI, real provider, model call or deployment certified. No foreign source, reservations, branch/PR metadata, CI or merge altered.