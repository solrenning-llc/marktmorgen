import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(process.cwd()+'/package.json');
const ts = require('typescript');
const paths=['tests/platform-share.test.ts','tests/fee-refund-receipt.test.ts','tests/share-lost-dispute.test.ts','tests/share-historical-read-evidence.test.ts','tests/share-unknown-dispute-report.test.ts'];
function assertions(text){
 const source=ts.createSourceFile('proof.ts',text,ts.ScriptTarget.Latest,true);
 const out=[];
 function visit(node){
  if(ts.isCallExpression(node)){
   const exp=node.expression;
   if((ts.isIdentifier(exp)&&exp.text==='is') || (ts.isPropertyAccessExpression(exp)&&ts.isIdentifier(exp.expression)&&exp.expression.text==='assert'))out.push(node.getText(source));
  }
  ts.forEachChild(node,visit);
 }
 visit(source); return out;
}
let total=0;
for(const path of paths){
 const before=execFileSync('git',['show','7902ca997db889acfc0458a025c137a5e3ee2a89:'+path],{encoding:'utf8'});
 const old=assertions(before),current=assertions(readFileSync(path,'utf8'));
 assert.deepEqual(current,old,path+': every existing assertion must remain byte-identical');
 total+=old.length;
}
console.log(JSON.stringify({files:paths.length,unchangedAssertions:total}));
