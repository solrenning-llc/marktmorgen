import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const deps=resolve(process.argv[2]||'node_modules');
const require=createRequire(join(deps,'esbuild/package.json'));
const {build}=require('esbuild');
for(const [name,sha]of [['podcast-access.ts','85599110f3f843be7817b401f86af75c5d71e81c'],['podcast-rules.ts','fbdf2567bd88fbce87caf7bb0581e23ae083c570']]){
 const b=readFileSync(join(root,'snapshot',name));
 const actual=createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
 if(actual!==sha)throw Error('Snapshot mismatch: '+name+' '+actual);
}
const out=mkdtempSync(join(tmpdir(),'n-2608-proof-'));
try{
 await build({entryPoints:[join(root,'tests/n-2608-podcast-erasure-race.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(out,'proof.cjs'),plugins:[{name:'pinned-boundaries',setup(b){b.onResolve({filter:/^@\//},args=>({path:args.path==='@/lib/podcast-access'?join(root,'snapshot/podcast-access.ts'):args.path==='@/lib/podcast-rules'?join(root,'snapshot/podcast-rules.ts'):join(root,'tests/n-2608-world.ts')}));}}],banner:{js:`globalThis.fetch=async()=>{throw Error('No external network allowed')};`}});
 const run=spawnSync(process.execPath,[join(out,'proof.cjs')],{encoding:'utf8',timeout:120000,maxBuffer:128*1024});
 process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
 if(run.error)throw run.error;process.exitCode=run.status===0?0:1;
}finally{rmSync(out,{recursive:true,force:true});}
