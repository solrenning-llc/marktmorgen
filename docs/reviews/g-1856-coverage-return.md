# Codex G — #1856 focal coverage return

Exact head 5009b57bda8bbdb3b6e0ad06c69044b314955c76. Focal return of LOW in G review5795354400 at8ba8783d2ad3da9b49e8ce2a601a78f18b1b49c8. Prior six G reviews retrieved/read in full; existing product findings closed there remain closed in this focal return, with their MCP/parent/main-integration/funding limits retained.

Entire corrective delta 8ba..5009 read: one commit, two test files. agent-book-durable.test.ts changes6/6; the fixture now accepts an explicit prior description and exercises unknown readback in BOTH nonempty and empty prior-description cases. Expected outcomes and prior assertions remain, three empty-prior assertions are added. The second file is the exact original G transport expansion,150lines, blob032b5428b8cdb71e472128f208cc06cf1235aa37. No product/source changes in this delta.

## LOW closed; no new finding in this corrective delta

The final canonical permanent test was copied unchanged into own detached RED copy at actual buggy product0657970645a07d58090857db85104279c66e94cf. Only test/runner copies changed:
- final permanent:52checks/3causal failures on065 ->52/52 at5009. The failing assertions are empty-before readback []/[17]/[{}] returning success without a restore. This directly catches the original bug; previous49case permanent had passed there.
- original independent transport proof blob032b5428, unchanged:65/7 on065 ->65/65 at5009.
- original independent empty-readback proof blobf461cc8dc6c6bde3f248bc1fd8b04f54222ba20b, unchanged:47/3 on065 ->47/47 at5009.

The permanent is *.test.ts and participates in repository discovery. Optional G proofs do not replace it. This closes coverageLOW5795354400 without changing product behavior.

## Linked validation

23 previously related existing groups plus four preserved G proofs all pass. Existing23:350customchecks+32node:test; preserved proofs29+20+4+3=56customchecks. Combined linked run27files:406customchecks+32node:test=438executed checks/tests,0fail/skip. These totals repeat scenarios and are not claimed as438independent adversarial controls. The three focal files above are reported separately.

Strict scoped TypeScript with actual agent-book/confirm/kinds/product-about/MemoryRedis and proofs0; ESLint bothchanged files0; public-data scanner3275tracked/0; corrective diff-check0.
An initial linked-run preparation guessed llms.test.ts instead of actual llms-txt.test.ts; the preflight assertion failed before running tests, and a dependent launcher only reported missingmanifest. Neither is counted as a product/test failure. Corrected manifest validated27existing paths, then the actual linked run completed0.
No globalbuild/verify/CI, nativeRedis, realprovider, browser or full signed-in journey. No margin/globalMCP/parent1821/futuremain-integration certification. Their existing review and funding dispositions remain required; no substitution for fixedCX72.
No author product, reservation, branch, CI or merge changed. Own copied source under /tmp/g1856-coverage-return@5009; /tmp/g1856-065 retains actualoldproduct. Existing runner tests/g-1856-run.mjs used without changes.
