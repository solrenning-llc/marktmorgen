import {build} from 'esbuild';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(), input=process.argv[2], ref=process.argv[3];
const route=resolve(root,'app/api/store/course/route.ts');
const source=ref?execFileSync('git',['show',`${ref}:app/api/store/course/route.ts`],{encoding:'utf8'}):readFileSync(route,'utf8');
const imports=ts.createSourceFile(route,source,ts.ScriptTarget.Latest,true).statements.filter(ts.isImportDeclaration);
const exports=new Set();
for(const item of imports){
 const mod=item.moduleSpecifier.text;
 if(['@/lib/assignment','@/lib/store-data','@/lib/assignment-rules'].includes(mod))continue;
 for(const el of item.importClause?.namedBindings?.elements??[])if(!el.isTypeOnly)exports.add(el.propertyName?.text??el.name.text);
}
const world=`import * as real from '${resolve(root,'lib/course.ts')}';\nconst w=()=>globalThis.__g2810;\n${[...exports].map(n=>n==='LockBusyError'?`export class LockBusyError extends Error{}`:n==='EMAIL_PATTERN'||n.endsWith('_PATTERN')?`export const ${n}=/./;`:n==='MAX_BODY_LENGTH'?`export const ${n}=100000;` :`export const ${n}=(...args)=>{if(w()?.['${n}'])return w()['${n}'](...args);if(real['${n}'])return real['${n}'](...args);throw new Error('unwired route dependency: ${n}');};`).join('\n')}`;
const aliases=testAliases(input.split('/').pop(),root,resolve(root,'tests'));
const plugins=[{name:'g-route-boundary-only',setup(b){
 b.onResolve({filter:/^@\//},a=>a.importer===route&&!['@/lib/assignment','@/lib/store-data','@/lib/assignment-rules'].includes(a.path)?{path:'world',namespace:'g-world'}:undefined);
 b.onLoad({filter:/.*/,namespace:'g-world'},()=>({contents:world,loader:'ts',resolveDir:root}));
 if(ref)b.onLoad({filter:/\/(?:lib\/assignment|app\/api\/store\/course\/route)\.ts$/},a=>({contents:execFileSync('git',['show',`${ref}:${a.path.slice(root.length+1)}`],{encoding:'utf8'}),loader:'ts',resolveDir:a.path===route?resolve(root,'app/api/store/course'):resolve(root,'lib')}));
}}];
const result=await build({entryPoints:[resolve(root,input)],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'error',alias:aliases,plugins});
const run=spawnSync(process.execPath,['-'],{input:result.outputFiles[0].contents,cwd:root,env:testEnvironment({...process.env,G2810_SOURCE_REF:ref??'b9ee75a390476513455d295036d41f04d61087fb'}),encoding:'utf8',maxBuffer:4*1024*1024});
process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;
