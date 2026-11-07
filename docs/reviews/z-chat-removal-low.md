# Local LOW correction for PR #2741

Credit: Claude 5 review6701833468 LOW1. The MEDIUM about unknown save counters returning429 remains unchanged and awaits independent reproduction/classification; this WIP neither closes it nor moves the official PR head ab5818b75c73ae66fffa1365677e46e0a2c3c400. Claude6-owned lib/chat-summary.ts and the shared request guard are unchanged.

The route still calls guardStoreWrite(settings,1000) before doing anything. Only an explicitly empty or whitespace string URL bypasses the provider-test counter, because setChatAddress deletes the setting without a supplier POST. Saves, malformed/non-string inputs and sales toggles keep their previous paths. No extra command or provider call is introduced: removal saves the two counter commands and keeps its existing single DEL. Unknown authorization/admission is not bypassed.

Rule23 was explained before code in reservation e76e998dfd86989cfc2721fa74a0b332810c9dad: the original removal expectation of two counter commands incorrectly charged a provider-test attempt for deleting the address. That one assertion is tightened to zero; all other original assertions remain, including genuine exceeded and lost-acknowledgment controls. Three new unknown/exceeded/whitespace cases require successful removal, exactly one DEL, zero counter commands/POSTs and continued authorization enforcement.

Durable RED2395e04083cd74d5ba662b9a95751501bc7089da (native ce554d78100545685feccac1c977c9a3eaf86692, tree938bb3d3f3585d97bddac2dcea2406d1239a6da7):31 cases,27PASS/4FAIL. Same31/31 after the route change. Original28 checks remain, with only the removal command-count expectation tightened as disclosed above. Scope types3 roots and lint2 paths passed. Linked request-guard-shape, plan-cost-registry and store-data-registry passed; their actual receipts are in the checkpoint. No browser, native Redis, live supplier, invoice or complete funding certification is claimed.

All executions use the existing declared auth/store and Redis transport stand-ins, real route/helper/sealing and intercepted supplier POSTs. Admission ceilings before execution:2000 synthetic commands/100 synthetic POSTs/100000 request bytes/120s/log128KiB per process; compiler1GiB. Per removal the test observes1 DEL/0 counter commands/0 POSTs. No aggregate command/byte measurement beyond the existing fixture output is claimed. Unknown cost is not zero. The real guard may refuse an unconfigured Redis before reaching this route; the test's counter-configuration stand-in is not an end-to-end deployment claim.

Reproduce from this evidence checkout with dependencies installed. This portable recipe uses the same runner operations as the temporary local runner; its portable import paths were not separately replayed. The permanent canonical test is already discovered normally. No global alias/config/source from another owner was changed. This WIP is not a new CI attempt or approval; consolidate the official PR only after the remaining findings are ready and independent reviews apply.

```sh
node --input-type=module <<'JS'
import { build } from 'esbuild';
import { testAliases, testEnvironment } from './tests/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(), out = mkdtempSync(join(tmpdir(), 'chat-removal-'));
try {
  for (const file of ['chat-counter-admission.test.ts', 'request-guard-shape.test.ts', 'plan-cost-registry.test.ts', 'store-data-registry.test.ts']) {
    const bundle = join(out, file + '.cjs');
    await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
    const r = spawnSync(process.execPath,[bundle],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:131072,encoding:'utf8'});
    process.stdout.write(r.stdout + r.stderr);
    if (r.status !== 0) process.exitCode = 1;
  }
} finally { rmSync(out,{recursive:true,force:true}); }
JS
```

Publication note: the first GitData request mistakenly used the new native RED tree as its base before it existed remotely. It and its dependent calls failed without a mutation. Rebuilding from the remote author's base tree produced the exact native RED tree, then the RED branch was created. This did not change the executed fixture or require another test run.
