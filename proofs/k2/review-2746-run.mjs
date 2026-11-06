import { build } from 'esbuild';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const before=execFileSync('git',['show','d653e4ad^:tests/renewal-unpaid.test.ts'],{cwd:root,encoding:'utf8'});
const current=readFileSync(join(root,'tests/renewal-unpaid.test.ts'),'utf8');
function assertions(text){const sf=ts.createSourceFile('fixture.ts',text,ts.ScriptTarget.Latest,true);const result=[];const printer=ts.createPrinter({removeComments:true});function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(sf)==='is')result.push(printer.printNode(ts.EmitHint.Unspecified,n,sf));ts.forEachChild(n,visit);}visit(sf);return result;}
assert.deepEqual(assertions(current),assertions(before));
assert.equal(assertions(current).length,68);
console.log('AST: all 68 original assertions unchanged');
const temp=mkdtempSync(join(tmpdir(),'k2-2746-'));let failed=0;
try{
 const ref=process.argv[2]??'HEAD';
 const files=process.argv.slice(3);if(!files.length)files.push('renewal-unpaid.test.ts');
 for(const file of files){
  let source=join(root,'tests',file);
  if(ref!=='HEAD'){
   assert.equal(file,'renewal-unpaid.test.ts');source=join(root,'tests','.k2-renewal-red.tmp.ts');
   writeFileSync(source,execFileSync('git',['show',`${ref}:tests/renewal-unpaid.test.ts`],{cwd:root}));
  }
  const out=join(temp,file+'.cjs');
  try{await build({entryPoints:[source],outfile:out,bundle:true,platform:'node',format:'cjs',alias:testAliases(file,root,join(root,'tests')),logLevel:'error',banner:{js:'const __k2DateNowBefore = Date.now; process.once("exit", () => { if (Date.now !== __k2DateNowBefore) throw new Error("Date.now was not restored"); console.log("Clock identity restored"); });'}});}finally{if(ref!=='HEAD')rmSync(source,{force:true});}
  const run=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});if(run.status!==0)failed++;
 }
}finally{rmSync(temp,{recursive:true,force:true});}
process.exitCode=failed?1:0;
