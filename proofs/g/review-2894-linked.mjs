import {build} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(),input=process.argv[2],ref=process.argv[3]||'e7a0e382d9e0897a679030ba9eda18155073fb9d';
if(!/^[0-9a-f]{40}$/.test(ref))throw Error('exact SHA40 required');
const git=(...args)=>execFileSync('/usr/local/bin/git',args,{cwd:root,encoding:'utf8'});
const tracked=new Set(git('ls-tree','-r','--name-only',ref).trim().split('\n'));
const alias=testAliases(input.split('/').at(-1),root,resolve(root,'tests'));
const plugin={name:'exact-own-snapshot',setup(b){
 b.onResolve({filter:/.*/},a=>{
  if(a.path.startsWith('node:'))return;
  let path=alias[a.path]||a.path;if(path.startsWith('@/'))path=resolve(root,path.slice(2));else if(path.startsWith('.'))path=resolve(a.resolveDir,path);
  if(!path.startsWith(root+'/'))return;
  for(const file of [path,path+'.ts',path+'.tsx',path+'.mjs',path+'/index.ts']){
   const rel=relative(root,file);if(tracked.has(rel)||(existsSync(file)&&statSync(file).isFile())){
    if(!existsSync(file)){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,git('show',ref+':'+rel));}
    return {path:file};
   }
  }
 });
 b.onLoad({filter:/\.[cm]?[jt]sx?$/},a=>{
  const rel=relative(root,a.path);if(!tracked.has(rel)||rel.startsWith('proofs/g/'))return;
  return {contents:git('show',ref+':'+rel),loader:a.path.endsWith('tsx')?'tsx':a.path.endsWith('ts')?'ts':'js',resolveDir:dirname(a.path)};
 });
}};
const result=await build({entryPoints:[resolve(root,input)],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',logLevel:'error',alias,plugins:[plugin]});
const child=spawnSync(process.execPath,['-'],{input:result.outputFiles[0].contents,encoding:'utf8',env:testEnvironment(process.env),timeout:120000,maxBuffer:1024*1024});
process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');if(child.error)console.error(child.error);process.exitCode=child.status??1;
