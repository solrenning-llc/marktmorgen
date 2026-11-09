import {build} from 'esbuild';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../../../tests/test-config.mjs';
const [file,mode]=process.argv.slice(2),root=process.cwd(),here=join(root,'tests');
const temp=mkdtempSync(join(tmpdir(),'v2892-'));
try{
 await build({entryPoints:[resolve(file)],bundle:true,platform:'node',format:'cjs',outfile:join(temp,'test.cjs'),logLevel:'error',alias:testAliases(file.split('/').at(-1),root,here),plugins:[{name:'bounded-original-graph',setup(b){
 b.onLoad({filter:/[\\/]lib[\\/]redis-memory\.ts$/},args=>{let contents=readFileSync(args.path,'utf8');const needle='run(command: (string | number)[]): unknown {';if(!contents.includes(needle))throw Error('Redis budget insertion point missing');contents=contents.replace(needle,needle+' (globalThis as unknown as {__vRedis:()=>void}).__vRedis();');return{contents,loader:'ts',resolveDir:join(root,'lib')};});

 }}]});
 const r=spawnSync(process.execPath,[join(temp,'test.cjs')],{env:testEnvironment(process.env),timeout:110000,maxBuffer:230000,encoding:'utf8',killSignal:'SIGKILL'});
 process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');
 console.log('V2892_CHILD '+JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message??null}));process.exitCode=r.status??1;
}finally{rmSync(temp,{recursive:true,force:true});}
