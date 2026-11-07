# Second financial review #3101: batch-byte regression reproduced

Codex Z, 7 November 2026. Exact `00535decc9e9d96e9032d09bbed8525e2ababca9`, base1d7cbe8dda5d35d049c699def9919b89a6376ef5. Requested C4-1746; PRclaim6713374326 preceded diff/source; channel REScc36a430 preceded own new code/tests. All four author paths were read, with the sales export route, wanted/readListings/listingFinder, serializer and CSV escaping. No author source/ref/CI changed. First S5814734679 is credited as the first completed opinion; this is the separately required second, not a new third opinion.

## Verdict

**Not clean: the first review's proposed MEDIUM batch-byte regression is independently reproduced; the required public-data scanner also remains RED in the author fixture.** No additional HIGH/MEDIUM is claimed. No numeric cost or margin clearance follows from passing registry tests.

`lib/catalog.ts:785,819-822`: `LISTING_MGET_KEYS=500` bounds keys, not the bytes of the whole listing records returned together. A listing carries a call schedule, not just a title. The copied S proof uses the actual readSetup/parseProduct/productWrites writer with500 products, each50 sessions and500-character HTTPS room URLs. First serialized listing29449bytes; records remain inside the writer's256000-byte bound. The catalog fixture names valid serialized products, explicitly has an empty head, and is not a claim that500 real UI writes were performed.

The S proof is preserved byte-for-byte: SHA256 `8ab720b671f136a27d5878192d7ee1c362cfcd374d31e241b49002a08a961a5e`, Gitbloba4b1ca4b8b188a9858320a769cfe9e9d5ab20fef. A declared synthetic10MiB answer ceiling is installed before the tested export; no live Redis/provider is contacted. Same source/assertions:

| Graph | Largest serialized REST-style answer | Product-read pipelines | Outcome |
|---|---:|---:|---|
| Old catalog+stats in final graph |30268bytes|500|500rows,partial=false,all4 assertions complete|
| Reviewed head |15127904bytes|1|Synthetic limit10485760 exceeded; export-success assertion fails, remaining3 assertions not reached|

This independently confirms the already-reported regression under the stated transport assumption, not a new incident or a different severity count. The source route catches export errors and returns502; the causal proof calls salesCsv, not the full HTTP/auth route. Repeating the same export does not shrink this deterministic batch. R2/C1 should classify/dispose the existing finding on this exact frozen source. The author can size batches from writer/encoding/envelope bounds or use a bounded name projection, without cutting products/sessions or visible commercial limits. Do not duplicate a shared correction from another agent.

Primary official documentation checked again2026-11-07:
- https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded reports10MB for Free/Pay-as-you-go, recommends splitting data, and warns that reading every element can exceed the limit.
- https://upstash.com/docs/redis/features/restapi documents the JSON result/pipeline semantics modeled by the adapter.

No publication/update date was displayed.10MiB is more permissive than decimal10MB; the deployed account/tier/actual service ceiling is NOT independently verified. No signup/database/configuration/token/contact or paid service experiment was performed. The documentation's optional setup suggestions were not followed.

## What passes

- Author FINAL19, Gitblobcae01947a936cb027fc0d2f857ea853eb5716bd0, identical in REDb5da85d2d and fix00535dec: before19checks/10FAIL, head19PASS.
- Linked head22catalog-read-count +18stats-report +9store-export-unknown-size +25plan-cost-registry +7store-data-registry all pass. Together with author19:100 reported ordinary checks across6files; these mix assertion-based runners and node:test cases, not100 new distinct scenarios.
- Additional independent pure UTF-8/CSV proof:8 node:test cases pass, across every declared column for ASCII,CJK,astral,quotes,backslashes,formula,unpaired surrogate and combining characters. CSV escaping plus defusing apostrophe remains inside the declared bound. This is an adversarial boundary check, not a baseline regression claim against a missing old cutToBytes export. No extra provider calls or database commands.
- The same S four-assertion proof is RED separately, not hidden in the ordinary passing count. Its old graph completes4 assertions; the head aborts at the first assertion after recording the transport refusal. Do not label this as four completed head cases.
- Actual tsconfig ES2017/strict/Bundler,7roots/1191imported sources:0diagnostics/exit0. Lint the same7TS roots:exit0. No full suite/global tsc/build/client-bundle/browser/AT certification.
- Required scanner on the unmodified tracked head:4305files/1failure, `tests/sales-file-cheaper.test.ts [provider-account]`. The fixture is synthetic, not a disclosed live account, but it still fails the mandatory scanner. It is the author's file; no Z edit to shorten it. Final evidence scan preserves the same finding; receipt included.

## Cost, scope and reproduction

The new registry diff is comments only; its essential price/formula is unchanged and explicitly not certified. A one-command MGET is not a byte bound. The dollar estimates, MGET tariff and whole company/refund margins are NOT independently approved here; unknown cost is never zero. The additional index/projection work in draft#3129 is outside this reviewed graph. The analogous call-listing batching concern was already recorded in Z's #3079 work; that is historical context, not a new finding or permission to copy its owner's code.

Tests were serial. Before every child:20,000 nested MemoryRedis.run,100 mocked HTTP calls,120s/512MiB/128KiB; type checker1024MiB/120s. Counters reject before dispatch, overflow is fatal, native socket connections and an unmocked fetch are refused before the module graph. Maximum3691memory/26mockHTTP in the author's old test; S proof old2035/6,head1536/6. Current author2490/26. Diagnostic strings over2000characters are truncated only for bounded output; assertion inputs and comparisons remain intact. No ceiling was hit.

RED substitutes ONLY old catalog.ts/stats.ts in the final graph; it is not an entire historical checkout. Own runner/proofs/logs are retained. No source expectation was changed to obtain GREEN. An initially mistyped RED object namee1111d231 belonged to the other draft's notes and was not present here; metadata/history established correctb5da85d2d and exact test-blob equality, with no repeated test execution or changed oracle.

Reproduce in exact00535dec checkout with own proof files and this directory, setting Z_TEST_ROOT when relocating it and supplying the named local esbuild dependency:

```sh
node docs/reviews/z-3101-sales-cost/runner.mjs sales-file-cheaper.test.ts s3101-batch-bytes.proof.ts z3101-csv-byte-boundaries.proof.ts
Z_RED=old node docs/reviews/z-3101-sales-cost/runner.mjs sales-file-cheaper.test.ts s3101-batch-bytes.proof.ts
```

The first group exits1 only because the copied batch proof remains RED; the old group exits1 because the authored test correctly fails before the correction. See per-file logs. No price, visible limit, commission, flag, gate, account, payment, author ref/CI/queue or foreign branch was changed. C1-TODOS14/15 are respected: evidence/review only, no new product PR or CI replay.
