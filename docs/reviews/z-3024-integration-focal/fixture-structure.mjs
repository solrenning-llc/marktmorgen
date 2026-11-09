import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const files=Object.keys(JSON.parse(readFileSync('proofs/v/3024/fixture-completion-counts.json','utf8'))),out=[],snapshots={};
function canonical(sf,strip){let omitted=0;const visit=n=>{if(ts.isPropertyAssignment(n)&&strip(n)){omitted++;return null;}const kids=[];ts.forEachChild(n,k=>{const c=visit(k);if(c!==null)kids.push(c);});return [n.kind,kids.length?kids:n.getText(sf)];};return {tree:visit(sf),omitted};}
for(const file of files){const old=execFileSync('git',['show','44f4e252cf787afca1152a703ab82b59a104162e:'+file],{encoding:'utf8',maxBuffer:262144}),head=readFileSync(file,'utf8');snapshots[file]={old,head};
 const strip=n=>n.name.getText()==='s'&&ts.isArrayLiteralExpression(n.initializer)&&n.initializer.elements.length===0;
 const a=canonical(ts.createSourceFile(file,old,ts.ScriptTarget.Latest,true),strip),b=canonical(ts.createSourceFile(file,head,ts.ScriptTarget.Latest,true),strip);
 assert.deepEqual(a.tree,b.tree,file+' changed beyond empty links');out.push({file,added:b.omitted-a.omitted,otherwiseSame:true});}
assert.equal(out.reduce((n,x)=>n+x.added,0),13);writeFileSync('docs/reviews/z-3024-integration-focal/fixture-structure.json',JSON.stringify(out,null,2)+'\n');writeFileSync('docs/reviews/z-3024-integration-focal/fixture-snapshots.json',JSON.stringify(snapshots,null,2)+'\n');console.log(JSON.stringify({files:out.length,addedEmptyLinks:13,otherwiseSame:true}));
