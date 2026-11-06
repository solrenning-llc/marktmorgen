import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const objectRoot=process.env.M2945_OBJECT_ROOT||root;
const gitDir=existsSync(join(objectRoot,'objects'))?objectRoot:join(objectRoot,'.git');
const sha='23f66687f471f7aeea3194edaf2fb7db02affbac';
const tree='eb53e01730e4bb007d9ed6dda70094104ff16acf';
const baseBlob='0b923767e9621e6be8a81a79899dfd5f2a49c9f5';
const source=join(root,'source');
const basePage=join(root,'source-base/app/studio/page.tsx');
const started=Date.now();
const outputs=[];
const deadline=setTimeout(()=>{console.error('HARNESS_CONTROL 120s total cap');process.exit(124);},120000);
const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
Object.assign(environment,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0'});
function remaining(){const n=120000-(Date.now()-started);if(n<=0)throw Error('120s execution cap');return n;}
function git(args,options={}){return execFileSync('/usr/bin/git',['--git-dir='+gitDir,'-c','protocol.allow=never',...args],{env:environment,encoding:'utf8',maxBuffer:4*1024*1024,timeout:Math.min(5000,remaining()),...options});}
function bytesAt(path){if(!existsSync(path))return 0;const st=lstatSync(path);if(st.isSymbolicLink())return 0;return st.isDirectory()?readdirSync(path).reduce((n,s)=>n+bytesAt(join(path,s)),0):st.size;}
function preflight(){
 const mem=Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo','utf8'))?.[1]||0)*1024;
 if(mem<1.5*1024**3)throw Error('At least 1.5GiB MemAvailable required');
 if(!readFileSync('/usr/bin/git').subarray(0,4).equals(Buffer.from([127,69,76,70])))throw Error('Native Git ELF required');
 if(!lstatSync(gitDir).isDirectory())throw Error('Ordinary Git directory required; linked-worktree gitfiles unsupported');
 const config=spawnSync('/usr/bin/git',['--git-dir='+gitDir,'config','--local','--no-includes','--name-only','--get-regexp','^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter)|include(if\\..*)?\\.path)$'],{env:environment,encoding:'utf8',timeout:5000,maxBuffer:4096});
 if(config.error||![0,1].includes(config.status)||config.status===0)throw Error('Object repository configuration rejected (partial/promisor/include or unreadable); no config values printed');
 for(const file of ['objects/info/alternates','objects/info/http-alternates'])if(existsSync(join(gitDir,file)))throw Error('Object alternates rejected');
 const pack=join(gitDir,'objects/pack');if(existsSync(pack)&&readdirSync(pack).some(s=>s.endsWith('.promisor')))throw Error('Promisor pack rejected before object reads');
 const objects=bytesAt(join(gitDir,'objects'));if(objects>128*1024**2)throw Error('128MiB object cap');
 console.log('PREFLIGHT '+JSON.stringify({nativeGit:'/usr/bin/git',globalSystemConfig:'ignored',externalProtocols:'blocked',promisorPartial:'rejected',memAvailable:mem,objectBytes:objects,heapLimitMiB:512}));
 if(git(['rev-parse',sha+'^{tree}']).trim()!==tree)throw Error('Head tree mismatch');
}
function hashBlob(b){return createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');}
let paths,bytes=0;
const loaded=new Set();
function writeExact(path,blob,target=join(source,path)){
 const b=git(['cat-file','blob',blob],{encoding:null});if(hashBlob(b)!==blob)throw Error('Object hash mismatch '+path);
 if(!loaded.has(path)){bytes+=b.length;if(bytes>16*1024**2)throw Error('16MiB source cap');loaded.add(path);}
 if(existsSync(target)&&!readFileSync(target).equals(b))throw Error('Existing source differs '+path);
 mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b);return target;
}
function materialize(path){const e=paths.get(path);if(!e)throw Error('No exact head import '+path);return writeExact(path,e);}
function resolveSource(candidate){for(const suffix of ['', '.ts','.tsx','.mjs','.js','/index.ts','/index.tsx'])if(paths.has(candidate+suffix))return candidate+suffix;throw Error('Missing exact source '+candidate);}
const networkGuard=String.raw`
globalThis.__m2945={caseCommands:0,totalCommands:0,faultKey:null,faultHits:0,protectedKeys:[],securityWrites:0,mails:0,mailAttempts:0,networkAttempts:0};
globalThis.fetch=async(input,init)=>{const s=globalThis.__m2945;const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url!=='https://api.resend.com/emails'||String(init?.method||'GET').toUpperCase()!=='POST'){s.networkAttempts++;throw Error('External fetch blocked before graph');}if(s.mails+1>6)throw Error('Synthetic email admission cap');s.mails++;return Response.json({id:'synthetic-m2945-only'});};
for(const [mod,names]of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']]]){const api=require(mod);for(const name of names)api[name]=()=>{globalThis.__m2945.networkAttempts++;throw Error('External transport blocked before graph');};}
`;
const nextWorld=String.raw`
export * from 'next/server.js';
export {cookies,headers} from '@/tests/security/next-headers';
export function after(task){void task;}
export function redirect(to){throw Error('REDIRECT '+to);}
export function permanentRedirect(to){throw Error('REDIRECT '+to);}
export function notFound(){throw Error('NOT_FOUND');}
export function useRouter(){return {back(){},forward(){},refresh(){},push(){},replace(){},prefetch(){}};}
export function usePathname(){return '/studio';}
export function useSearchParams(){return new URLSearchParams();}
`;
const memoryWorld=String.raw`
import {MemoryRedis} from 'm2945-memory-original';export {MemoryRedis};
const original=MemoryRedis.prototype.run;
MemoryRedis.prototype.run=function(command){const s=globalThis.__m2945;if(s.caseCommands+1>3000||s.totalCommands+1>18000)throw Error('Command admission cap before MemoryRedis.run');s.caseCommands++;s.totalCommands++;if(s.faultKey&&command[0]==='GET'&&command[1]===s.faultKey){s.faultHits++;throw Error('Synthetic selected GET unread');}if(s.faultKey&&command[0]!=='GET'&&command.some(x=>s.protectedKeys.includes(String(x))))s.securityWrites++;return original.call(this,command);};
`;
const transportWorld=String.raw`
export {prepareResendFallbackFixture,createResendFallbackFixture,currentResendFallbackProofIsMissing} from 'm2945-transport-original';
import {guardedResendPost as original} from 'm2945-transport-original';
export async function guardedResendPost(...args){const s=globalThis.__m2945;if(s.mailAttempts+1>6)throw Error('Synthetic transport admission cap');s.mailAttempts++;return original(...args);}
`;
try{
 preflight();
 paths=new Map(git(['ls-tree','-rz',sha]).split('\0').filter(Boolean).flatMap(line=>{const m=/^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);return m?[[m[2],m[1]]]:[];}));
 materialize('tests/test-config.mjs');
 writeExact('CONTROL_BASE_PAGE',baseBlob,basePage);
 const {testAliases,testEnvironment}=await import(join(source,'tests/test-config.mjs'));
 const aliases=testAliases('m-2945-studio-security.proof.tsx',source,join(source,'tests'));
 const plugin={name:'verified-head-source',setup(b){
  b.onResolve({filter:/.*/},args=>{
   if(args.path==='m2945-memory-original')return {path:materialize('lib/redis-memory.ts')};
   if(args.path==='m2945-transport-original')return {path:materialize('tests/resend-fallback-fixture.ts')};
   if(args.path==='@/lib/redis-memory')return {path:'memory',namespace:'m2945-world'};
   if(args.path==='@/lib/resend-fallback-transport')return {path:'transport',namespace:'m2945-world'};
   if(['next/headers','next/navigation','next/server'].includes(args.path))return {path:'next',namespace:'m2945-world'};
   let candidate=args.path;
   for(const [key,val]of Object.entries(aliases).sort((a,b)=>b[0].length-a[0].length)){if(candidate===key||candidate.startsWith(key+'/')){candidate=val+candidate.slice(key.length);break;}}
   if(candidate.startsWith('@/'))candidate=join(source,candidate.slice(2));
   if(candidate.startsWith('.')&&args.importer.startsWith(source+'/'))candidate=resolve(dirname(args.importer),candidate);
   if(candidate.startsWith(source+'/'))return {path:materialize(resolveSource(relative(source,candidate)))};
   if(candidate!==args.path)return {path:candidate};
   if(args.namespace==='m2945-world')return {path:requireResolution(args.path)};
   return null;
  });
  b.onLoad({filter:/.*/,namespace:'m2945-world'},args=>({contents:args.path==='next'?nextWorld:args.path==='memory'?memoryWorld:transportWorld,loader:'js',resolveDir:root}));
 }};
 // A virtual module's only external import is the official installed Next entry.
 function requireResolution(path){if(path==='next/server.js')return join(root,'node_modules/next/server.js');throw Error('Unresolved virtual import '+path);}
 async function compile(entry,name){const file=join(root,'validation',name+'.cjs');outputs.push(file);await build({entryPoints:[entry],outfile:file,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'error',nodePaths:[join(root,'node_modules')],banner:{js:networkGuard},plugins:[plugin]});return file;}
 function execute(file,cwd){const r=spawnSync(process.execPath,['--max-old-space-size=512',file],{cwd,env:testEnvironment({...environment,NODE_ENV:'test',NIMBUS_DATA_KEY:'tests-only-not-a-real-deployment-secret',RESEND_API_KEY:'re_test_second_step_gate_only'}),encoding:'utf8',timeout:remaining(),maxBuffer:128*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;return r;}
 const author=await compile(materialize('tests/studio-security-unread.test.ts'),'author-security');
 for(const [which,cwd,status,ending]of [['base',join(root,'source-base'),1,'9 checks, 2 failing.'],['head',source,0,'9 checks, all passing.']]){console.log('AUTHOR_SOURCE '+which);const r=execute(author,cwd);if(r.status!==status||!r.stdout.includes(ending))throw Error('AUTHOR_SOURCE_CONTROL unexpected '+which+' result');console.log('AUTHOR_SOURCE_CONFIRMED '+which+' status='+r.status);}
 const proof=await compile(join(root,'tests/m-2945-studio-security.proof.tsx'),'independent-security');
 console.log('SOURCE '+JSON.stringify({head:sha,tree,baseControlBlob:baseBlob,files:loaded.size,bytes,completeBaseTree:false}));
 const result=execute(proof,root);process.exitCode=result.status??2;
 console.log('DRIVER '+JSON.stringify({status:result.status,elapsedMs:Date.now()-started,sourceBytes:bytes,sourceFiles:loaded.size}));
}catch(error){console.error('HARNESS_CONTROL',error);process.exitCode=2;}finally{clearTimeout(deadline);for(const file of outputs)if(existsSync(file))rmSync(file);}
