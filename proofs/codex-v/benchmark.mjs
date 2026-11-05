import {readdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {build} from './marktmorgen/node_modules/esbuild/lib/main.js';
import {testAliases,testEnvironment} from './marktmorgen/tests/test-config.mjs';
const root=process.cwd(),here=join(root,'tests'),out=mkdtempSync(join(tmpdir(),'codex-v-bench-'));
const all=readdirSync(here).filter(f=>f.endsWith('.test.ts')).sort();
const files=all.filter((_,i)=>i%Math.floor(all.length/60)===0).slice(0,60);
const compile=async file=>{const bundle=join(out,file+'.cjs');await build({entryPoints:[join(here,file)],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',alias:testAliases(file,root,here)});return bundle;};
const run=bundle=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,[bundle],{env:testEnvironment(process.env),stdio:['ignore','pipe','pipe']});let output='';c.stdout.on('data',x=>output+=x);c.stderr.on('data',x=>output+=x);c.on('error',reject);c.on('close',(status,signal)=>resolve({status,signal,bytes:output.length}));});
try{
 const report=[];
 for(const mode of ['serial','pipeline','pipeline','serial']){
  const start=performance.now(),results=[];let pending=mode==='pipeline'?compile(files[0]):null;
  for(let i=0;i<files.length;i++){
   const bundle=mode==='pipeline'?await pending:await compile(files[i]);
   if(mode==='pipeline')pending=i+1<files.length?compile(files[i+1]):null;
   results.push({file:files[i],...await run(bundle)});
  }
  const row={mode,ms:Math.round(performance.now()-start),count:results.length,failed:results.filter(x=>x.status!==0),statusHash:createHash('sha256').update(JSON.stringify(results.map(({file,status,signal})=>({file,status,signal})))).digest('hex')};
  report.push(row);console.log(JSON.stringify(row));writeFileSync('../benchmark-results.json',JSON.stringify({files,report},null,2));
 }
}finally{rmSync(out,{recursive:true,force:true});}
