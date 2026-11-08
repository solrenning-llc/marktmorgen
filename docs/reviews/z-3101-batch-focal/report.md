# Z focused financial return: sales-file batch bytes

Reviewed on 7 November 2026 (Fortaleza), exact subject `5d50793a82d356610467d9c9cbfc7bc1e646ac7d`, corrective delta from `00535decc9e9d96e9032d09bbed8525e2ababca9`. This returns to Z review 5815160635; S's first focal 5815698869 is credited, not replaced.

Original transport MEDIUM: **closed at its cause in this delta**. No new HIGH/MEDIUM demonstrated. This is a focused product opinion, not permission to push/merge during the current main-red hold or a certificate of global margin.

Read the full four-file corrective diff, complete changed catalog function and its writer ceiling, and the sales-export caller. `MAX_PRODUCT_BYTES=256000`; `(6*256000+3)*5=7680015`, below the 8000000 answer budget with room for an envelope. Batches now contain five records, four batches in flight. Membership, duplicate filtering, exact response length/type, malformed listing rejection, missing-record fallback and CSV implementation remain unchanged. The registry changes only comments and explicitly labels the extra command estimate unmeasured; no tariff/global funding certification is made.

## Identical proof, before and after

The copied S proof is byte-identical: SHA256 `8ab720b671f136a27d5878192d7ee1c362cfcd374d31e241b49002a08a961a5e`. It builds 500 records through real `readSetup`, `parseProduct` and `productWrites`, each with 50 sessions and a 500-character room URL. Each listing is 29449 bytes. The synthetic transport ceiling is 10485760 bytes, not an observed deployed provider limit.

* Only catalog/stats from 00535 in the final graph: largest answer 15127904 bytes, one product read, export fails at the FIRST assertion; three later assertions are not reached.
* Exact corrective subject: largest answer 151294 bytes, 100 product reads, 500 rows, partial=false, all four assertions pass.

Permanent author seven-case test SHA256 `8175dcc5d14e45e0be4fc7545485e6713fe656bc03dec512387d275ae6971342`, Git blob `f062595281752cb7cc41849bae8a0845529c1e2c`, is identical in RED368ea32e and subject. Same old-module overlay: 7/7 fail; subject: 7/7 pass. This test also uses raw synthetic padded fixtures; the independent original proof above separately exercises the real writer.

## Validation

Current results: original proof 4, permanent test 7, current sales-file-cheaper 19, catalog-read-count 22, stats-report 18, store-export-unknown-size 9 node cases, plan-cost-registry 25 node cases, store-data-registry 7 node cases. All pass: 70 check assertions plus 41 node cases, overlapping coverage explicitly declared. This is not 111 distinct newly invented scenarios. The cheaper test's trip expectation changed for the new five-record batching; it is NOT claimed byte-identical to the historical original19.

Actual scoped TypeScript: seven roots, 1191 source files, ES2017/strict/Bundler, zero diagnostics, exit0. ESLint: five relevant TS files, exit0. Corrective diff-check exit0. Public-data scanner results are in scanner.log; read its actual result before claiming clearance. No browser, full build, native Redis/Lua, live provider, queue or CI was run.

All tests used the included bounded runner, serial: before dispatch 20000 nested MemoryRedis.run calls and 100 mock HTTP calls per child, 120 seconds, 512 MiB heap, 128 KiB output. Network sockets denied before loading the graph; fetch starts denied and later assigned stand-ins remain counted. Max observed per child: 2728 nested calls and 26 mock HTTP. Original proof old1536/6, new1635/6; permanent old536/6, new635/6. Types ran alongside tests under its separately admitted 1024 MiB budget and completed in less than 120 seconds. No limit was increased or assertion weakened.

Reproduce from this evidence checkout (install/reuse dependencies first):

```
Z_RED=old node docs/reviews/z-3101-batch-focal/runner.mjs s3101-batch-bytes.proof.ts sales-file-batch-bytes.test.ts
node docs/reviews/z-3101-batch-focal/runner.mjs s3101-batch-bytes.proof.ts sales-file-batch-bytes.test.ts sales-file-cheaper.test.ts catalog-read-count.test.ts stats-report.test.ts store-export-unknown-size.test.ts plan-cost-registry.test.ts store-data-registry.test.ts
node --max-old-space-size=1024 docs/reviews/z-3101-batch-focal/types.mjs
```

Runner defaults and dependency path name this review workspace; `Z_TEST_ROOT` overrides the checkout. Preserve the frozen proof and raw logs. Old overlay qualifies comparison to only old catalog/stats in the final dependency graph, not a full historical checkout.

## Remaining qualifications

LOW source/documentation caveat, same as S: catalog.ts848-850 accumulates ALL answers before parsing. Four limits simultaneous requests, **not total resident answers to 31 MB**. Narrow that comment to in-flight data. No supported-writer OOM experiment or new MEDIUM is asserted. Legacy records exceeding today's writer cap are outside the byte-bound premise. Dollar estimates, honest essential pricing, global MR and the new 27/79 refund budgets remain their owners' work; this focal changes no numerical policy.

Claim6715117032 preceded new source. Channel RES adc37748aace635c538b26d4fb8e8c4f138abd18/b6bb508e52cf53bd3813af3ae35b88a97e0ddb8f preceded new proof files and tests; immutable FULL readback exact. Earlier CAS409 did not write; retry respected >=120 seconds and >=5-minute FULL cadence. Main-red hold prevents product PR pushes, not this review. Own products2741/2819 and pending reminder proof remain untouched.
