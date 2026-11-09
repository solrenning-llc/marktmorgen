import ts from "typescript";
import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
const old="4bdc231e4a82c16f3bb1c0c12269edb33a057926",result=[];
function calls(s,file){const a=[];const f=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true);function visit(n){if(ts.isCallExpression(n)&&["is","assert","strictEqual","deepStrictEqual","ok"].includes(n.expression.getText(f)))a.push(n.getText(f));ts.forEachChild(n,visit)}visit(f);return a;}
for(const file of ["tests/checkup.test.ts","tests/stripe-account-written.test.ts"]){const a=execFileSync("git",["show",old+":"+file],{encoding:"utf8"}),b=readFileSync(file,"utf8");const x=calls(a,file),y=calls(b,file);const expected=a.replaceAll('"inactive"','"restricted"');const r={file,assertionCalls:x.length,assertionsByteIdentical:JSON.stringify(x)===JSON.stringify(y),wholeSourceOnlyNominalFixtureSubstitution:expected===b,substitutions:(a.match(/"inactive"/g)||[]).length};result.push(r);if(!r.assertionsByteIdentical||!r.wholeSourceOnlyNominalFixtureSubstitution)throw Error(JSON.stringify(r));}
console.log(JSON.stringify(result,null,2));writeFileSync("docs/reviews/z-3311-enum-focal/fixture-ast.json",JSON.stringify(result,null,2)+"\n");
