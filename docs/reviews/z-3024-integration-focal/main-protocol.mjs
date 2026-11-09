import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const path='lib/community.ts',base='44f4e252cf787afca1152a703ab82b59a104162e';
const main=ts.createSourceFile(path,execFileSync('git',['show',base+':'+path],{encoding:'utf8',maxBuffer:262144}),ts.ScriptTarget.Latest,true),head=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const pick=sf=>sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='setProfile');
let removedType=0,removedConst=0,removedSpreads=0;
const transform=ctx=>root=>{
 const visit=node=>{
  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='links')){removedConst++;return undefined;}
  if(ts.isTypeLiteralNode(node)){const members=node.members.filter(m=>{if(ts.isPropertySignature(m)&&m.name.getText(head)==='links'){removedType++;return false;}return true;});return ts.visitEachChild(ts.factory.updateTypeLiteralNode(node,members),visit,ctx);}
  if(ts.isObjectLiteralExpression(node)){const properties=node.properties.filter(m=>{if(ts.isSpreadAssignment(m)&&ts.isIdentifier(m.expression)&&m.expression.text==='links'){removedSpreads++;return false;}return true;});return ts.visitEachChild(ts.factory.updateObjectLiteralExpression(node,ts.factory.createNodeArray(properties,node.properties.hasTrailingComma)),visit,ctx);}
  return ts.visitEachChild(node,visit,ctx);
 };return ts.visitNode(root,visit);
};
const result=ts.transform(pick(head),[transform]),printer=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed});
const a=printer.printNode(ts.EmitHint.Unspecified,pick(main),main),b=printer.printNode(ts.EmitHint.Unspecified,result.transformed[0],head);
assert.equal(a,b);assert.deepEqual([removedType,removedConst,removedSpreads],[1,1,2]);
writeFileSync('docs/reviews/z-3024-integration-focal/main-protocol.json',JSON.stringify({base,same:true,removedType,removedConst,removedSpreads,mainFunction:a,headWithoutOnlyLinks:b},null,2)+'\n');
console.log(JSON.stringify({same:true,removedType,removedConst,removedSpreads}));result.dispose();
