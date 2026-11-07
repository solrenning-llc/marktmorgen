# Codex J: focused sparse-history return for PR #2934

Corrective candidate: `claude6/c5-fix-2934@9ec04bb427f34b4934cb171993f724dc7be59b34`. Request6709666175. At preflight, PR head remained3e15c17d20e076c08f68080a241fc7222120f2f0, OPEN/unmerged. Reservation7242dc189/FULL exact readback and PR6710179767 preceded source/diff/tests. This closes the two remaining LOWs in J5813414204 on the exact candidate; it does not clear unadvanced3e15. No new blocking focal finding demonstrated.

## Cause and proof

The entire corrective delta has two paths: lib/physical-legal.ts and tests/sz2-physical-legal.test.ts. Every index is validated before sorting, so a hole rejects the whole history as `unreadable`. Recording copies a malformed list with its holes intact; a subsequent read remains unknown. Dense history and known empty lists retain their meaning. The public recordPrice signature is unchanged; its implementation signature accepts unknown and can hand back unreadable input without returning readonly PriceStep[] as mutable. No suppression or target/lib change.

Same separate J8 file copied BYTE-ID, SHA256 ddcc5b71bbf911347f2972cb0296d985232e2f74865d77762c78de682e0f39ab: 8 PASS. The historical frozen4 old-return-contract proof remains immutable; its documented3PASS/1FAIL excludes the explicit new string and is not called4GREEN. That mismatch was disposed6709340309 before the separate8 was created; it was not rerun here.

The FINAL permanent91 assertions, unchanged, run with ONLY lib/physical-legal.ts replaced by3e15 in the final graph:91/6FAIL. Five sparse cases fail and the actual compiler assertion reports TS4104. Exact9ec:91PASS. The separately named return runner changes target guards and the old-module pin; in old-module mode ONLY, the permanent test's compiler-host readFile is intercepted for that same source path so runtime AND compiler see the identical old module. It does not alter any assertion/expected value, settings, library or other source. This distinction matters: runtime replacement alone would leave the compiler reading the new on-disk file.

Current tests total141 passing checks:8J +91permanent +42English (overlap in behaviors, not141independent new scenarios). No other productive importer of physical-legal found. Unchanged store-sale/shipping checks were not repeated. Directed actual repository ES2017 strict/bundler types over source, permanent test and J8: explicit exit0. Lint4 exit0. Official scanner4135 tracked/0 findings, own3 separately scanned/0; diff exit0. Explicit statuses and raw logs below; diagnostic blank-line whitespace normalized in this output artifact only, raw/tmp logs retained.

## Limits and scope

Every test child:120s,512MiB V8 heap,256KiB captured log, fetch/socket/http(s) blocked with negative controls BEFORE graph; MemoryRedis.run observer20000 pre-dispatch, actual0 in all children. Zero external provider calls. No browser/assistive technology/legal-source research/statutory compliance/checkout/native Redis/Lua/globalTSC/Nextbuild/CI/MR certification. Pure unwired module only. No author source/ref/CI/push/main integration/enqueue/merge mutation.

## Reproduction and preservation

This evidence branch retains historical product base3dc and all original proofs/reports. COPY tests/j-2934-focal.proof.ts and scripts/j-2934-sparse-return.mjs to a NEW exact9ec checkout before execution; old3e15 Git object is required. Runner refuses tracked source differences outside explicit own evidence paths. Existing frozen4 and prior8/runner unchanged. Modes: `node scripts/j-2934-sparse-return.mjs head j-2934-focal.proof.ts`; `old-module` (permanent91); `head` (permanent91); `head platform-us-english.test.ts`. Independent directed compiler command: node --max-old-space-size=512 node_modules/typescript/bin/tsc --noEmit -p /tmp/j2934-9ec-types.json. That JSON extends the exact repository tsconfig and only selects the three listed roots, disables incremental/plugins, and sets node type roots; target/strict/module resolution preserved.

Source blob14dd7a510a6b9c23685c0e6dc6fa9e26247d51f9; permanent bf6396211978c8cb35ba2c34f6ffbfc67fb5b281; tsconfigf126992ca95c6da5359e547a2e58e92fccd3d02c. Raw logs /tmp/j2934-9ec-*.log/status.json/types.json. Native evidence keeps prior history; remote tree must equal native, each new blob FULL read back. Author still owns promotion and all integration/queue gates.
