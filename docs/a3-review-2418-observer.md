# A3 upstream diagnosis of the native gate on PR 2418

Historical author head: `7bd3eb3d3ecc17e5ca920681329f8a815d09ae07`.
CI job: `127006767724`. Its decoded log fails the protected-origin profile assertion with enqueue27/create18/bound_replay15/cursor17/bind18 against the unchanged expected create17.

The two application Lua sources involved are byte-identical between that head and the current A3 accounting correction `7f0279a5ff3f9b9d05fa994c7c9fa700bff1755f`: `lib/order-confirmation-outbox.ts` and `lib/shipment-mail-outbox.ts`. The relevant Python change in the latter source replaces the open server-wide INFO observation window with the existing atomic command observer. No command ceiling changes.

`scripts/review_a3_2418_observer.py` loads the exact old test from its Git object, verifies both Lua files are unchanged, and injects exactly one separate client's PING after the old observer's initial INFO for the create profile. Owned disposable Redis7.4.12 then reproduces the exact CI profile dictionary, including create18. The current exact suite receives the same interference and retains create17, with all native assertions and its four linked Node groups (55 tests) passing. The existing measurement controls also run: external PING is excluded but application PING and INFO remain billed. The proof's server is stopped and its synthetic keys are removed.

This deterministically explains how the old measurement can produce that precise CI signature. It does not establish which external command actually ran during the historical job, and does not certify the unrelated community-reward change. Its independent content review remains with the assigned reviewer.

The observer correction is already included in the unchanged #2338 candidate; it does not require the download feature in #2020. No extra product fix, command-count increase, quota/price/flag change or source edit in the O branch is proposed. Under CX122(15), the owner can repeat only that untouched failing job once when its workflow is terminal, if it has not already been repeated, then require all nine final-head successes. Alternatively, integrating the actual merged parent after #2338 will carry the permanent observer fix; fresh exact-head checks are still mandatory. A rerun is not a substitute for any genuine assertion failure.

Proof scope: exact native Lua/profile accounting and the current complete outbox test entrypoint with synthetic fixtures. No real provider, account, payment, deployment or complete company cost certification. No O branch or CI was changed.
