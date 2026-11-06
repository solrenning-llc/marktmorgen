import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { testAliases, testEnvironment } = await import(join(root, 'tests/test-config.mjs'));
const out = mkdtempSync(join(tmpdir(), 'c2-api-read-'));
try {
  const linked = process.argv.includes('--linked');
  const targets = linked ? ['cart.test.ts','cart-physical.test.ts','digital-consent.test.ts',
    'preorders.test.ts','waitlist.test.ts','assignments.test.ts','task-room-unknown.test.ts']
    : ['c2-api-read-decision.proof.ts'];
  let failed = 0;
  for(const target of targets){
    const alias = testAliases(linked ? target : 'cart-physical.test.ts', root, join(root, 'tests'));
    if(!linked){
      alias['next/headers'] = join(root, 'tests/security/next-headers.ts');
      alias['@/lib/blob'] = join(root, 'tests/buyer-actions-blob.ts');
    }
    const bundle=join(out,`${target}.cjs`);
    await build({entryPoints:[join(root, 'tests',target)],bundle:true,
      platform:'node',format:'cjs',outfile:bundle,alias,logLevel:'error'});
    const run = spawnSync(process.execPath,[bundle],{
      cwd:root,env:testEnvironment({...process.env,TMPDIR:tmpdir()}),encoding:'utf8',timeout:90_000,
      maxBuffer:16*1024*1024,
    });
    if(run.error) throw run.error;
    console.log(`=== ${target}: exit ${run.status} ===`);
    console.log(linked&&run.status===0 ? run.stdout.slice(-700) : run.stdout);
    if(run.status!==0){failed++;console.error(run.stderr);}
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(out,{recursive:true,force:true});
}
