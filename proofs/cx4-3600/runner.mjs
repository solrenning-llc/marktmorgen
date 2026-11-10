import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(),dir=resolve('proofs/cx4-3600'),head='9cb50bbbecbce57d3fd90e890614103af6a6e0bb';
const git=(args)=>execFileSync('git',args,{cwd:root,timeout:30000,maxBuffer:2*1024*1024});
if(git(['rev-parse','HEAD']).toString().trim()!==head)throw Error('Unexpected subject head');
const want=JSON.parse(readFileSync('package.json')).dependencies.next,installed=JSON.parse(readFileSync('node_modules/next/package.json')).version;
if(want!==installed)throw Error('Exact Next mismatch');
const paths=git(['diff','--name-only','origin/main...'+head]).toString().trim().split('\n');
const hashes=[];
for(const p of paths){const content=git(['show',head+':'+p]),sha=git(['rev-parse',head+':'+p]).toString().trim();const calculated=createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');if(sha!==calculated)throw Error('Git blob mismatch '+p);const working=readFileSync(p,'utf8').replace(/\r\n/g,'\n');if(working!==content.toString('utf8'))throw Error('Checkout differs '+p);hashes.push({path:p,git:sha,sha256:createHash('sha256').update(content).digest('hex')});}
writeFileSync(join(dir,'subject-hashes.json'),JSON.stringify({head,want,installed,files:hashes},null,2));
const old=git(['show','012b860aa3635e189d76825a1627d05439088eff:app/api/store/chat-summary/route.ts']);writeFileSync(join(dir,'route-red.ts'),old);
const cap={redis:20000,http:100,bytes:100000},used={redis:0,http:0,bytes:0,network:0},results=[];
const cases=[['red','tests/z-chat-counter-refusal.proof.ts','chat-counter-admission.test.ts',true],['proof','tests/z-chat-counter-refusal.proof.ts','chat-counter-admission.test.ts',false],['permanent','tests/chat-counter-admission.test.ts','chat-counter-admission.test.ts',false],['guard','tests/request-guard-shape.test.ts','request-guard-shape.test.ts',false],['own','proofs/cx4-3600/own.proof.ts','chat-counter-admission.test.ts',false]];
for(const [label,file,canonical,red] of cases){
 const dest=join(dir,label);mkdirSync(dest,{recursive:true});
 const alias=testAliases(canonical,root,join(root,'tests'));if(red)alias['@/app/api/store/chat-summary/route']=join(dir,'route-red.ts');
 const output=join(dest,'bundle.cjs');
 const compiled=await build({entryPoints:[resolve(file)],bundle:true,platform:'node',format:'cjs',outfile:output,metafile:true,alias,logLevel:'error',plugins:[{name:'cx4-pre-dispatch',setup(b){
 b.onLoad({filter:/redis-memory\.ts$/},args=>{let s=readFileSync(args.path,'utf8');const needle='run(command: (string | number)[]): unknown {';if(s.split(needle).length!==2)throw Error('Memory instrumentation mismatch');return{loader:'ts',contents:s.replace(needle,needle+' (globalThis as any).__cx4Redis();')};});
 b.onLoad({filter:/chat-counter-admission-world\.ts$/},args=>{let s=readFileSync(args.path,'utf8');const needle='  state.commands.push(...commands);';if(s.split(needle).length!==2)throw Error('Fixture instrumentation mismatch');return{loader:'ts',contents:s.replace(needle,'  for (const c of commands) (globalThis as any).__cx4Redis();'+needle)};});
 b.onLoad({filter:/redis-stub\.ts$/},args=>{let s=readFileSync(args.path,'utf8');const needle='=> store.pipeline(commands);';if(s.split(needle).length!==2)throw Error('Stub instrumentation mismatch');return{loader:'ts',contents:s.replace(needle,'=> { for (const c of commands) (globalThis as any).__cx4Redis();return store.pipeline(commands); };')};});
 }}]});
 writeFileSync(join(dest,'inputs.json'),JSON.stringify(compiled.metafile,null,2));
 const limits=Object.fromEntries(Object.entries(cap).map(([k,v])=>[k,v-used[k]]));
 const env=testEnvironment({PATH:process.env.PATH,NODE_PATH:resolve('node_modules'),NODE_ENV:'test',TEMP:resolve('.cx4-3600'),TMP:resolve('.cx4-3600'),UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic',CX4_LIMITS:JSON.stringify(limits)});
 const r=spawnSync(process.execPath,['--max-old-space-size=512','--import',pathToFileURL(join(dir,'preload.mjs')).href,output],{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:262144});
 const stdout=r.stdout??'',stderr=r.stderr??'';writeFileSync(join(dest,'stdout.log'),stdout);writeFileSync(join(dest,'stderr.log'),stderr);
 const match=stderr.match(/CX4_LEDGER (\{[^\n]+\})/);if(!match)throw Error('Missing ledger '+label);const ledger=JSON.parse(match[1]);for(const k of Object.keys(used))used[k]+=ledger[k];if(used.network||Object.keys(cap).some(k=>used[k]>cap[k]))throw Error('Review cap/network breach');
 const record={label,status:r.status,signal:r.signal,error:r.error?.code,ledger,stdoutTail:stdout.trim().split('\n').slice(-10)};results.push(record);writeFileSync(join(dir,'results.json'),JSON.stringify({head,limits:cap,used,results},null,2));console.log(JSON.stringify(record));
 if(r.error||r.signal||![0,1].includes(r.status))throw Error('Inconclusive runtime '+label);
 if(label==='red'&&r.status===0)throw Error('Original RED unexpectedly green');
 if(['proof','permanent','guard'].includes(label)&&r.status!==0)throw Error('Permanent/control failure '+label);
}
console.log('FINAL '+JSON.stringify({head,used,results:results.map(r=>({label:r.label,status:r.status}))}));
