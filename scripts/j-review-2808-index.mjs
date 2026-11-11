import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../tests/test-config.mjs';
const root=resolve(import.meta.dirname,'..'),out=mkdtempSync(join(tmpdir(),'j-2808-index-'));
try{const bundle=join(out,'proof.cjs');await build({entryPoints:[join(root,'tests/j-2808-index.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases('certificate-copy-evidence.test.ts',root,join(root,'tests'))});const r=spawnSync(process.execPath,[bundle],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});process.exitCode=r.status??1;}finally{rmSync(out,{recursive:true,force:true});}
