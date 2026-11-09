import ts from 'typescript';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const paths=['tests/community-member-links.test.ts',...Object.keys(JSON.parse(readFileSync('proofs/v/3024/fixture-completion-counts.json','utf8')))];
const rows=[];
for(const path of paths){
 const base=path==='tests/community-member-links.test.ts'?'cde4e3ee9b5741ea1a32933d293f9b297c358d5c':'44f4e252cf787afca1152a703ab82b59a104162e';
 const r=spawnSync('git',['show',`${base}:${path}`],{encoding:'utf8',maxBuffer:262144});if(r.status!==0)throw Error('Missing original '+path);
 const collect=text=>{const src=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true),out=[];const walk=n=>{if(ts.isCallExpression(n)&&(/^(is|assert(?:\..+)?)$/.test(n.expression.getText(src))))out.push(n.getText(src));ts.forEachChild(n,walk);};walk(src);return out;};
 const old=collect(r.stdout),now=collect(readFileSync(path,'utf8'));if(JSON.stringify(old)!==JSON.stringify(now))throw Error('Assertion changed '+path);
 rows.push({path,base,assertionCalls:old.length,exact:true,sha256:createHash('sha256').update(JSON.stringify(old)).digest('hex')});
}
writeFileSync('docs/reviews/z-3024-integration-focal/assertion-identities.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify({files:rows.length,assertionCalls:rows.reduce((s,x)=>s+x.assertionCalls,0),allExact:rows.every(x=>x.exact)}));
