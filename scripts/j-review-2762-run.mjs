import {build} from 'esbuild';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),out=mkdtempSync(join(tmpdir(),'j2762-'));
try {
 const bundle=join(out,'proof.cjs');
 await build({entryPoints:['tests/j-2762-unknown-publication.proof.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases('bv1-letter-preview.test.ts',root,join(root,'tests'))});
 const result=spawnSync(process.execPath,[bundle],{stdio:'inherit',env:testEnvironment(process.env)});
 process.exitCode=result.status??1;
} finally {rmSync(out,{recursive:true,force:true});}
