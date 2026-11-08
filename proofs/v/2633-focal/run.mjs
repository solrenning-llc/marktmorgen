import {build} from 'esbuild';import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
const [name,file,mode='head']=process.argv.slice(2),temp=mkdtempSync(join(tmpdir(),'v2633-'));
try{
 const b=await build({entryPoints:[file],outfile:join(temp,'test.cjs'),bundle:true,platform:'node',format:'cjs',metafile:true,logLevel:'error'});
 const imports=Object.keys(b.metafile.inputs);writeFileSync(`proofs/v/2633-focal/${name}-imports.json`,JSON.stringify(imports,null,2)+'\n');
 if(imports.some(x=>/node_modules\/next\/|lib\/redis(?:-memory)?\.ts/.test(x)))throw Error('Impure graph: reserved runtime budgets not instrumented');
 const r=spawnSync(process.execPath,['--max-old-space-size=512','--import',resolve('proofs/v/2633-focal/deny.mjs'),join(temp,'test.cjs')],{env:{...process.env,V2633_OLD:mode==='old'?'yes':'no'},timeout:120000,maxBuffer:262144,encoding:'utf8',killSignal:'SIGKILL'});
 const s=(r.stdout??'')+(r.stderr??'')+'\nV2633 '+JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null})+'\n';writeFileSync(`proofs/v/2633-focal/${name}.log`,s);console.log(s);process.exitCode=r.status??1;
}finally{rmSync(temp,{recursive:true,force:true});}
