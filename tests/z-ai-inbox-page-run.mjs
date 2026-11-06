import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const own=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]||own);
const {build}=await import(join(own,'node_modules/esbuild/lib/main.js'));
const dir=mkdtempSync(join(tmpdir(),'z-ai-inbox-page-'));
try{
 const world=join(own,'tests/z-ai-inbox-page-world.ts');const alias={'@':root,'next/headers':world,'next/navigation':world};
 for(const name of ['studio-route','ai','email','house-store','inbox','team'])alias['@/lib/'+name]=world;
 for(const name of ['studio-header','studio-store-pin','inbox-studio'])alias['@/components/'+name]=world;
 await build({entryPoints:[join(own,'tests/z-ai-inbox-page.proof.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(dir,'proof.cjs'),alias,logLevel:'error'});
 const r=spawnSync(process.execPath,[join(dir,'proof.cjs')],{cwd:root,stdio:'inherit'});process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
