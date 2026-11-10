import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(),donor=resolve(root,'node_modules');
const require=createRequire(import.meta.url),{build}=require(join(donor,'esbuild'));
const requested=JSON.parse(readFileSync('package.json')).dependencies.next,installed=JSON.parse(readFileSync(join(donor,'next/package.json'))).version;
if(requested!==installed)throw Error('Exact Next mismatch before graph');
// No framework runtime is allowed when the exact Next version is unavailable.
const [file,label,capText,canonical='chat-counter-admission.test.ts']=process.argv.slice(2),cap=Number(capText??100);if(!Number.isSafeInteger(cap)||cap<1||cap>20000)throw Error('Invalid cap');
if(!/^[a-z0-9-]{1,48}$/i.test(label??''))throw Error('Invalid output label');
const out=resolve('proofs/z-chat-refusal-local',label);mkdirSync(out,{recursive:true});
const result=await build({entryPoints:[resolve(file)],bundle:true,platform:'node',format:'cjs',outfile:join(out,'bundle.cjs'),metafile:true,nodePaths:[donor],alias:testAliases(canonical,root,join(root,'tests')),plugins:[{name:'pre-dispatch-cap',setup(b){b.onLoad({filter:/redis-memory\.ts$/},args=>{const needle='run(command: (string | number)[]): unknown {';const s=readFileSync(args.path,'utf8');if(s.split(needle).length!==2)throw Error('Memory cap instrumentation mismatch');return{contents:s.replace(needle,needle+'(globalThis as any).__zCounterAdmission();'),loader:'ts'};});b.onLoad({filter:/redis-stub\.ts$/},args=>{const s=readFileSync(args.path,'utf8');const needle='=> store.pipeline(commands);';if(s.split(needle).length!==2)throw Error('Pipeline cap instrumentation mismatch');return{contents:s.replace(needle,'=> {for(const c of commands)(globalThis as any).__zCounterAdmission();return store.pipeline(commands);};'),loader:'ts'};});b.onLoad({filter:/chat-counter-admission-world\.ts$/},args=>{let s=readFileSync(args.path,'utf8');const needle='  state.commands.push(...commands);';if(s.split(needle).length!==2)throw Error('Fixture instrumentation mismatch');return{contents:s.replace(needle,' for(const c of commands)(globalThis as any).__zCounterAdmission();'+needle),loader:'ts'};});}}],logLevel:'silent'});
writeFileSync(join(out,'inputs.json'),JSON.stringify(result.metafile,null,2));
if(/require\([\"']next(?:\/|[\"'])/.test(readFileSync(join(out,'bundle.cjs'),'utf8'))&&requested!==installed){writeFileSync(join(out,'result.json'),JSON.stringify({admitted:false,reason:'Retained Next mismatch before runtime',requested,installed}));console.log('REFUSED_NEXT '+label);process.exit(2);}
const ownPreload=join(out,'counter-preload.cjs');writeFileSync(ownPreload,`let n=0;global.__zCounterAdmission=()=>{if(n>=${cap}){process.stderr.write('COUNTER_CAP\\n');process.exit(86);}n++;};process.on('exit',()=>process.stderr.write('COUNTER_ADMISSIONS '+n+'\\n'));`);
const env=testEnvironment({PATH:process.env.PATH,NODE_PATH:donor,NODE_ENV:'test',UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic'});
const run=spawnSync(process.execPath,['--max-old-space-size=512','--import',pathToFileURL(resolve('proofs/z-chat-refusal-local/preload.mjs')).href,'--require',ownPreload,join(out,'bundle.cjs')],{cwd:root,env,timeout:120000,maxBuffer:131072,encoding:'utf8'});
writeFileSync(join(out,'stdout.log'),run.stdout??'');writeFileSync(join(out,'stderr.log'),run.stderr??'');writeFileSync(join(out,'result.json'),JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message,next:{requested,installed},counterCap:cap}));console.log(JSON.stringify({label,status:run.status,signal:run.signal,stdout:run.stdout?.slice(-600),stderr:run.stderr?.slice(-350)}));process.exitCode=run.status??2;
