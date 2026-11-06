/** Opt-in G check: baseline checkout path is explicit; compare assertion call texts, never source-side predicates. */
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const baseline=process.argv[2];
if(!baseline)throw new Error('Pass the prior f79 checkout path');
function calls(path,match){
 const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),out=[];
 const walk=node=>{if(ts.isCallExpression(node)&&match(node.expression.getText(source)))out.push(node.getText(source));ts.forEachChild(node,walk);};
 walk(source);return out;
}
for(const [name,oldFile,newFile,match] of [
 ['G16','g1929-title-summary-history.proof.ts','g1929-title-summary-history-eval.proof.ts',value=>value==='is'],
 ['I2','review-i2-agent-confirmation.test.ts','review-i2-agent-confirmation.test.ts',value=>value.startsWith('assert.')],
]){
 const before=calls(resolve(baseline,'tests',oldFile),match),after=calls(resolve('tests',newFile),match);
 const identical=JSON.stringify(before)===JSON.stringify(after);
 console.log(JSON.stringify({name,beforeCalls:before.length,afterCalls:after.length,identical}));
 if(!identical)process.exitCode=1;
}
