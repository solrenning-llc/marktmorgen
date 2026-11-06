/** Exact Git sources projected on demand; write:false bundles run on stdin. */
import { build } from 'esbuild';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';
const root=process.cwd(),repo=resolve(process.env.Q_REVIEW_REPO??root),source=process.env.Q_REVIEW_SOURCE_REF??'HEAD';
const git=(...args)=>execFileSync('git',args,{cwd:repo,env:{...process.env,GIT_NO_LAZY_FETCH:'1'},maxBuffer:32*1024*1024});
const files=new Set(git('ls-tree','-r','--name-only',source).toString().trim().split('\n'));
const project=file=>{
 const target=join(root,file);let body;
 if(files.has(file))body=git('show',`${source}:${file}`);
 else if(existsSync(target))body=readFileSync(target);
 else throw Error(`Review source missing: ${file}`);
 if(!existsSync(target)||!readFileSync(target).equals(body)){mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body);}
 return body.toString();
};
const locate=raw=>{
 const p=raw.replaceAll('\\','/').replace(/^\.\//,'');
 for(const candidate of [p,p+'.ts',p+'.tsx',p+'.mjs',p+'.js',p+'.json',p+'/index.ts',p+'/index.tsx'])
  if(files.has(candidate)||existsSync(join(root,candidate))&&statSync(join(root,candidate)).isFile())return candidate;
 throw Error(`Review resolution missing: ${p}`);
};
for(const file of process.argv.slice(2)){
 const aliases=testAliases(file,root,join(root,'tests')),names=Object.keys(aliases).sort((a,b)=>b.length-a.length);
 const plugin={name:'exact-git-source',setup(b){
  b.onResolve({filter:/.*/},args=>{
   let p=args.path;const name=names.find(n=>p===n||p.startsWith(n+'/'));
   if(name)p=aliases[name]+p.slice(name.length);
   let rel;
   if(p.startsWith(root+'/'))rel=relative(root,p);
   else if(args.namespace==='review-source'&&p.startsWith('.'))rel=relative(root,resolve(dirname(args.importer),p));
   else return;
   return{path:join(root,locate(rel)),namespace:'review-source'};
  });
  b.onLoad({filter:/.*/,namespace:'review-source'},args=>{
   const p=relative(root,args.path),ext=extname(p);
   return{contents:project(p),loader:ext==='.tsx'?'tsx':ext==='.ts'?'ts':ext==='.json'?'json':'js',resolveDir:root};
  });
 }};
 try{
  const result=await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'error',plugins:[plugin],absWorkingDir:root,
   banner:{js:"globalThis.fetch=async()=>{throw Error('Q review prohibits unmocked external fetch');};"}});
  const run=spawnSync(process.execPath,[],{cwd:root,input:result.outputFiles[0].text,encoding:'utf8',env:testEnvironment({...process.env,TMPDIR:process.env.TMPDIR??'/tmp'}),timeout:120000,maxBuffer:8*1024*1024});
  const log=`FILE ${file} SOURCE ${source} EXIT ${run.status}\n${run.stdout??''}\n${run.stderr??''}\n${run.error?String(run.error):''}\n`;
  const bounded=log.length>262144?log.slice(0,4096)+'\n[log truncated]\n'+log.slice(-250000):log;
  appendFileSync(join(root,'proofs/q/review-2860.log'),bounded);console.log(bounded);
  if(run.status!==0)process.exitCode=1;
 }catch(error){console.error('REVIEW SETUP FAILURE',file,String(error));process.exitCode=2;break;}
}
