import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';
const root = process.cwd();
const temp = mkdtempSync('/dev/shm/q-2845-run.');
try {
  for (const file of process.argv.slice(2)) {
    const output = join(temp, 'bundle.cjs');
    await build({entryPoints:[resolve(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
    const r = spawnSync(process.execPath,[output],{cwd:root,env:testEnvironment({...process.env,TMPDIR:'/dev/shm'}),encoding:'utf8'});
    const log = `FILE ${file} EXIT ${r.status}\n${r.stdout}\n${r.stderr}\n`;
    appendFileSync(join(root,'proofs/q/review-2845.log'),log);
    console.log(log);
    if(r.status !== 0) process.exitCode=1;
  }
} finally { rmSync(temp,{recursive:true,force:true}); }
