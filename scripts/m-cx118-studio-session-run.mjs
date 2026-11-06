import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {dirname,resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const gitRoot=process.env.CX118_OBJECT_ROOT||root;
const sha='1721109f1d2d3930cde6c54f6fe71412648043e3';
const source=join(root,'source');
const started=Date.now();
const deadline=setTimeout(()=>{console.error('120s total execution cap');process.exit(124);},120000);
const paths=new Set(execFileSync('git',['ls-tree','-r','--name-only',sha],{cwd:gitRoot,encoding:'utf8',timeout:5000}).trim().split('\n'));
let bytes=0;
function materialize(path){
 const target=join(source,path);
 const data=execFileSync('git',['show',sha+':'+path],{cwd:gitRoot,maxBuffer:4*1024*1024,timeout:Math.max(1,Math.min(5000,120000-(Date.now()-started)))});
 bytes+=data.length;if(bytes>16*1024*1024)throw Error('16 MiB source cap');
 if(existsSync(target)&&!readFileSync(target).equals(data))throw Error('Frozen source mismatch '+path);
 mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);return target;
}
materialize('tests/test-config.mjs');
const {testAliases,testEnvironment}=await import(join(source,'tests/test-config.mjs'));
const world=join(root,'tests/m-cx118-studio-session-world.tsx');
const aliases={...testAliases('m-cx118-studio-session.proof.tsx',source,join(source,'tests')),'next/headers':world,'next/navigation':world,'next/server':world};
const pinPaths=['app/studio/page.tsx','lib/studio-route.ts','lib/team.ts','lib/auth.ts','lib/passkeys.ts','lib/two-step.ts','lib/second-step-gate.ts','lib/app-code-invite-words.ts'];
for(const path of pinPaths){const file=materialize(path);console.log('PIN '+path+' '+createHash('sha256').update(readFileSync(file)).digest('hex'));}
const loaded=new Set(pinPaths.concat('tests/test-config.mjs'));
function frozenPath(candidate){for(const suffix of ['', '.ts','.tsx','.mjs','.js','/index.ts','/index.tsx']){let p=candidate+suffix;if(paths.has(p))return p;}return null;}
const output=join(root,'.cx118-bundle.cjs');
try{
 await build({entryPoints:[join(root,'tests/m-cx118-studio-session.proof.tsx')],bundle:true,platform:'node',format:'cjs',outfile:output,jsx:'automatic',logLevel:'error',nodePaths:[join(root,'node_modules')],plugins:[{name:'exact-frozen-source',setup(b){b.onResolve({filter:/.*/},args=>{
 let candidate=args.path;
 for(const [key,val]of Object.entries(aliases).sort((a,b)=>b[0].length-a[0].length)){if(candidate===key||candidate.startsWith(key+'/')){candidate=val+candidate.slice(key.length);break;}}
 if(candidate.startsWith('@/'))candidate=join(source,candidate.slice(2));
 if(candidate.startsWith('.')&&args.importer.startsWith(source+'/'))candidate=resolve(dirname(args.importer),candidate);
 if(candidate.startsWith(source+'/')){const p=frozenPath(relative(source,candidate));if(!p)throw Error('Missing frozen import '+candidate);if(!loaded.has(p)){materialize(p);loaded.add(p);}return {path:join(source,p)};}
 if(candidate!==args.path)return {path:candidate};
 return null;
 });}}]});
 console.log('SOURCE '+JSON.stringify({sha,bytes,files:loaded.size,pins:pinPaths.length}));
 const remaining=120000-(Date.now()-started);if(remaining<=0)throw Error('120s run cap before execution');
 const r=spawnSync(process.execPath,[output],{cwd:root,env:testEnvironment({...process.env,NODE_ENV:'test'}),encoding:'utf8',timeout:remaining,maxBuffer:128*1024});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;process.exitCode=r.status??1;
}finally{clearTimeout(deadline);if(existsSync(output))rmSync(output);}
