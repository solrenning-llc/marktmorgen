import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=mkdtempSync(join(tmpdir(),'k2-podcast-proof-'));
try {
 const alias={'@':root};
 for(const name of ['redis','order-data','metered-limits','request-guard','community-access','email','auth','buyer-words/courses']) alias['@/lib/'+name]=join(root,'proofs/k2/podcast-grant-world.ts');
 const outfile=join(temp,'proof.cjs');
 await build({entryPoints:[join(root,'proofs/k2/podcast-grant-read.proof.ts')],outfile,bundle:true,platform:'node',format:'cjs',alias,logLevel:'error'});
 const r=spawnSync(process.execPath,[outfile],{cwd:root,stdio:'inherit'});process.exitCode=r.status??1;
} finally {rmSync(temp,{recursive:true,force:true});}
