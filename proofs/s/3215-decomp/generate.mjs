import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const sha=s=>createHash('sha256').update(s).digest('hex');
const manifest={subject:'f78f7e2c1f831b272c9f1dcd7baf23d4e7f5a7c2',reservation:'81d29342f7b89ff363298884177615f827669809',policy:'C4-1725 decomposition; all original oracles retained; no ceiling increase',sources:[]};
function oracles(node,source){const out=[];function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='is'){const text=source.slice(n.getStart(),n.end);out.push({line:source.slice(0,n.getStart()).split('\n').length,text,sha256:sha(text)});}ts.forEachChild(n,visit);}visit(node);return out;}
for(const [name,prefix,skip] of [['dunning-cursor-after-send','dunning',4],['billing-reminder-marks','billing',3]]){
 const path=`tests/${name}.test.ts`,source=readFileSync(path,'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
 const main=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='main');if(!main?.body)throw Error('main missing');
 const parts=[];const shared=[];const setup=[];let current;
 for(const stmt of main.body.statements){
  if(ts.isFunctionDeclaration(stmt)){shared.push(source.slice(stmt.getFullStart(),stmt.end));continue;}
  const expr=ts.isExpressionStatement(stmt)&&stmt.expression;
  if(expr&&ts.isCallExpression(expr)&&expr.expression.getText(ast)==='done')continue;
  if(expr&&ts.isCallExpression(expr)&&expr.expression.getText(ast)==='part'){current={title:expr.arguments[0].text,statements:[]};parts.push(current);}
  if(current)current.statements.push(stmt);else setup.push(source.slice(stmt.getFullStart(),stmt.end));
 }
 const entry={path,gitBlob:execFileSync('git',['rev-parse',`HEAD:${path}`],{encoding:'utf8'}).trim(),sha256:sha(source),originalSource:source,oracles:oracles(main,source),parts:[]};
 for(const [index,part] of parts.entries()){
  const oracleList=part.statements.flatMap(s=>oracles(s,source));
  const item={index,title:part.title,oracles:oracleList,status:index===skip?'not-dispatched-original-ceiling':'scheduled'};
  if(index!==skip){
   const file=`tests/s-3215-decomp-${prefix}-${index+1}.proof.ts`;
   const text=source.slice(0,main.getFullStart())+'\n/** Independently reset original scenario; see the complete provenance manifest. */\nasync function main(): Promise<void> {\n'+setup.join('\n')+'\n'+shared.join('\n')+'\n'+(prefix==='dunning'?'void withReply; void running; void behind; void threeStores;':'void trial; void failing; void sentTo; void sendReminders; void sendFailedPlanNotices;')+'\n'+part.statements.map(s=>source.slice(s.getFullStart(),s.end)).join('\n')+'\n  done();\n}\n\nvoid main();\n';
   const derivedAst=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const got=oracles(derivedAst,text);
   if(JSON.stringify(got.map(o=>o.sha256))!==JSON.stringify(oracleList.map(o=>o.sha256)))throw Error('oracle identity changed');
   writeFileSync(file,text);item.file=file;item.sha256=sha(text);
  }
  entry.parts.push(item);
 }
 const flattened=entry.parts.flatMap(p=>p.oracles.map(o=>o.sha256));if(JSON.stringify(flattened)!==JSON.stringify(entry.oracles.map(o=>o.sha256)))throw Error('missing or reordered original oracle');
 manifest.sources.push(entry);
}
manifest.originalOracles=manifest.sources.reduce((n,s)=>n+s.oracles.length,0);
manifest.scheduledOracles=manifest.sources.flatMap(s=>s.parts).filter(p=>p.file).reduce((n,p)=>n+p.oracles.length,0);
manifest.notDispatchedOracles=manifest.originalOracles-manifest.scheduledOracles;
if(manifest.originalOracles!==27||manifest.scheduledOracles!==22)throw Error('unexpected original oracle count');
writeFileSync('proofs/s/3215-decomp/oracle-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({original:manifest.originalOracles,scheduled:manifest.scheduledOracles,notDispatched:manifest.notDispatchedOracles,children:manifest.sources.flatMap(s=>s.parts).filter(p=>p.file).map(p=>p.file)}));
