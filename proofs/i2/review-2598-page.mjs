import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
const root=process.env.TASK_TEST_ROOT;
const {build}=await import(root+'/node_modules/esbuild/lib/main.js');
const ts=(await import(root+'/node_modules/typescript/lib/typescript.js')).default;
const {testAliases,testEnvironment}=await import(root+'/tests/test-config.mjs');
const path=root+'/app/[handle]/thanks/page.tsx';
const virtual=new Map();
const out=mkdtempSync(tmpdir()+'/i2-preorder-page-');
const plugin={name:'controlled-page-context',setup(b){
 b.onLoad({filter:/thanks\/page\.tsx$/},args=>{
  if(args.path!==path)return;
  const source=readFileSync(path,'utf8'),sf=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let result=source;
  const changes=[];
  for(const node of sf.statements){
   if(!ts.isImportDeclaration(node)||!node.importClause||node.importClause.isTypeOnly)continue;
   const name=node.moduleSpecifier.text;
   if(name==='react'||name==='@/lib/money'||name==='@/lib/store-language'||name==='@/lib/preorders'||name.startsWith('@/lib/buyer-words'))continue;
   const names=[];if(node.importClause.name)names.push('default');
   const bindings=node.importClause.namedBindings;
   if(bindings&&ts.isNamedImports(bindings))for(const e of bindings.elements)if(!e.isTypeOnly)names.push((e.propertyName??e.name).text);
   const key='i2-thanks-world:'+name;virtual.set(key,{name,names});
   changes.push([node.moduleSpecifier.getStart(sf),node.moduleSpecifier.end,JSON.stringify(key)]);
  }
  for(const[start,end,text]of changes.reverse())result=result.slice(0,start)+text+result.slice(end);
  return{contents:result,loader:'tsx',resolveDir:root+'/app/[handle]/thanks'};
 });
 b.onResolve({filter:/^i2-thanks-world:/},args=>({path:args.path,namespace:'i2-world'}));
 b.onLoad({filter:/.*/,namespace:'i2-world'},args=>{
  const{name,names}=virtual.get(args.path);
  const call=`function call(n,args){const f=globalThis.__i2ThanksWorld?.[${JSON.stringify(name)}]?.[n];if(typeof f!=='function')throw Error('Unexpected page dependency '+${JSON.stringify(name)}+'.'+n);return Reflect.apply(f,undefined,args);}`;
  return{contents:call+names.map(n=>n==='default'?`export default (...args)=>call('default',args);`:`export const ${n}=(...args)=>call(${JSON.stringify(n)},args);`).join('\n'),loader:'js'};
 });
}};
try{await build({entryPoints:[root+'/tests/review-i2-preorder-page-access.test.ts'],bundle:true,platform:'node',format:'cjs',outfile:out+'/test.cjs',logLevel:'error',alias:testAliases('review-i2-preorder-page-access.test.ts',root,root+'/tests'),plugins:[plugin]});const r=spawnSync(process.execPath,[out+'/test.cjs'],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});process.exitCode=r.status??1;}finally{rmSync(out,{recursive:true,force:true});}
