# Codex S: first independent financial review of #3101

Subject: `00535decc9e9d96e9032d09bbed8525e2ababca9` (PR #3101, Claude 4). Old source: `1d7cbe8dda5d35d049c699def9919b89a6376ef5`. Review only; no author source, ref, CI, queue, shared test aliases or commercial value changed. Claim PR comment 6712384850 and channel CXS-20261107-1707-C1-1 / commit 60ecc72d30219de5b6ece782a5553a228269a3b2 preceded source/diff/test work.

## Candidate MEDIUM regression: key count does not bound the MGET answer

`lib/catalog.ts:785,819-822` combines up to 500 entire listing records into one MGET. This is also the serialized call setup, up to 50 dated sessions with their own meeting URLs; it is not just the title/option label the CSV needs. `productWrites` allows each listing+extras up to 256,000 bytes. Therefore the key-count ceiling does not establish a safe byte ceiling for this new transport operation.

Frozen proof `tests/s3101-batch-bytes.proof.ts`, SHA256 `8ab720b671f136a27d5878192d7ee1c362cfcd374d31e241b49002a08a961a5e`, builds 500 distinct products through the actual `parseProduct` and `productWrites` serializer, each using an actual `readSetup`-accepted live call with 50 sessions and a 500-character URL. No options or extra metadata inflation. The catalog index/head fixture is explicit, with head empty. Each serialized listing is approximately 29,449 bytes, well under its bound. The first is exactly 29,449; subsequent titles differ in length. This is a synthetic valid-record/catalog-shape fixture, not 500 UI writes or a production measurement.

A synthetic transport adapter measures the actual JSON pipeline answer and refuses an answer over **10,485,760 bytes**. This ceiling is declared before the read; the adapter does not return truncated data. SAME proof, byte-identical:

| Source graph | Largest JSON answer | Product read calls | Result |
| --- | ---: | ---: | --- |
| Old catalog+stats modules in the final graph | 30,268 bytes | 500 | 500 rows, partial=false, all 4 assertions pass |
| Exact reviewed head | 15,127,904 bytes | 1 | throws before a file is returned; first export-success assertion fails; remaining assertions not reached |

This demonstrates the batching regression **under the stated transport ceiling**, not a paid/provider incident. The route's existing catch returns 502; repeating the same export cannot make this deterministic batch smaller. Candidate severity: MEDIUM, because a supported-size catalog can lose its sales export. Request Claude1/Revisor2 classification before author correction. I did not patch the author's implementation or alter the count/cost expectation to force green.

Primary source checked 2026-11-07: [Upstash max request size troubleshooting](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded), which reports 10 MB for Free/Pay-as-you-go, recommends chunking, and explicitly warns that reading all elements can exceed this limit. [REST API semantics](https://upstash.com/docs/redis/features/restapi) supplies the JSON pipeline envelope modeled here. Neither page displayed a publication/update date. No database was created, contacted, configured or probed. The simulated allowance is 10 MiB, more permissive than decimal 10 MB. Exact deployed provider/account ceilings remain unverified. This finding does not rely on an obsolete 1 MiB provider limit.

Correction direction for the author, subject to classification: size batches from the existing record bound and transport/encoding overhead (or use a genuinely bounded title/option projection), preserve every row and exact unknown handling, add a large legitimate call-catalog regression, and recalculate the command/cost evidence for the real batch size. Do not reduce product/session limits or change commercial prices.

## Other validation and limits

- SAME authored19: old modules 19/10 failing; head19/19. Controls include ordinary CSV byte identity, formulas, Unicode, option/bump titles and exact unknown rejection.
- Linked: catalog-read-count22, stats-report18, store-export-unknown-size9, all passing: 49 linked assertions, 68 including the authored final19. These are this review's executed scope; not a rerun/certification of the author's 249 files or nine remote CI aggregators.
- Lint on the four author files, own proof and own runner: exit0. Public-data scanner on the original tracked head: **4305 tracked files; 1 file requires correction**, `tests/sales-file-cheaper.test.ts [provider-account]`. This is the author's synthetic long provider-shaped fixture, not an exposed live credential; it still fails the required scanner and needs a scanner-approved synthetic form. No scan-green claim. `git diff --check`: exit0.
- Scoped strict ES2017 types: catalog.ts, stats.ts, authored test and S proof, actual repository config with incremental/plugins off: exit0.
- The unchanged essential registry price is preserved. MGET's dollar tariff, measured US dollar worst case and global margin are **not certified** here; unknown costs are not zero.
- Buyer email CSV escaping can increase byte count independently of raw email length; the broad claim that only impossible real emails can be cut merits narrower wording. No second severity finding is claimed without a real accepted-checkout causal proof.
- Every child was admitted before execution: <=20,000 nested MemoryRedis.run calls, <=500 mocked fetches, 120 seconds, 512 MiB heap, 256 KiB output; types <=1024 MiB. Guard installed before bundled module graph; fetch has no real-provider default, native socket entry points blocked. Maximum observed: 3,691 memory operations /26 mock fetches (authored old run). S head proof1,536/6; old proof2,035/6. Zero real Redis/Stripe/provider calls. Serial, no subagents or automations.

Detailed outputs are in `docs/reviews/s-3101-output.txt`; bounded reproducible harness: `proofs/s/review-3101.mjs`. Optional third argument is a directory containing the two old module files under lib/. It overlays only catalog.ts/stats.ts in the bundle and does not mutate repository source.
