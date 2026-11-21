/** STN10 unit 3: real exit/export JSX rendered in isolation. No billing, session, browser or provider certification. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Extract on every run so a captured fixture can never hide a product regression.
const path='app/studio/page.tsx';
const source=readFileSync(path,'utf8');
const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const found:{cancel:ts.JsxElement[];data:ts.JsxElement[]}={cancel:[],data:[]};
const tag=(n:ts.Node)=>ts.isJsxElement(n)?n.openingElement.tagName.getText(tree):'';
function visit(n:ts.Node){
  if(ts.isJsxElement(n)){
    if(tag(n)==='details'&&n.children.some(c=>tag(c)==='summary'&&/Cancel the subscription/.test(c.getText(tree))))found.cancel.push(n);
    if(tag(n)==='div'&&n.children.some(c=>tag(c)==='p'&&/main data, as one file/.test(c.getText(tree))))found.data.push(n);
  }
  ts.forEachChild(n,visit);
}
visit(tree);
assert.equal(found.cancel.length,1,'one real cancellation section');
assert.equal(found.data.length,1,'one real main-data export card');
const expression=(node:ts.Node)=>{
  while(node.parent&&!ts.isJsxExpression(node))node=node.parent;
  assert.ok(ts.isJsxExpression(node),'keep the original visibility guard');
  return node.getText(tree);
};
const extracted=`function ExitSource({canExport=true,trialing=false,endsOn='Nov 30, 2026',closing=false,standing='paid',subscriptionId='synthetic-subscription'}){
  const may=(permission)=>permission==='export'&&canExport;
  const pin='',store={sid:'synthetic-store',subscriptionId};
  return <>${expression(found.data[0])}${expression(found.cancel[0])}</>;
}`;
const compiled=ts.transpileModule(extracted,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
const ExitSource=new Function('React',compiled+'\nreturn ExitSource;')(React) as React.ComponentType<Record<string,unknown>>;

const render=(canExport=true,trialing=false,endsOn:string|null='Nov 30, 2026')=>renderToStaticMarkup(React.createElement(ExitSource,{canExport,trialing,endsOn}));
const exit=(html:string)=>html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0]??'';

test('the real exit retains the cancel form without requiring a reason',()=>{
  const html=exit(render());
  assert.match(html,/action="\/api\/billing\/cancel"/);
  assert.match(html,/name="intent" value="cancel"/);
  assert.doesNotMatch(html,/\brequired(?:=|[\s>])/);
  assert.match(html,/Yes, cancel it/);
});
test('the supplied end date is visible in both paid and trial exits',()=>{
  for(const trial of [false,true])assert.match(exit(render(true,trial)),/Nov 30, 2026/);
});
test('the existing export keeps its permission guard and scope explanation',()=>{
  assert.match(render(true),/main data, as one file/);
  assert.match(render(true),/Files and videos download from their own pages/);
  assert.doesNotMatch(render(false),/main data, as one file/);
});
test('an authorized creator can reach the existing export from inside the exit',()=>{
  assert.match(exit(render(true)),/<a\b[^>]*href="#store-data-export"/);
});
test('the fragment target exists and accepts keyboard focus',()=>{
  assert.match(render(true),/<(?:div|h[1-6]|p)\b(?=[^>]*id="store-data-export")(?=[^>]*tabindex="-1")[^>]*>/);
});
test('the exit never offers the export fragment to a role without export permission',()=>{
  assert.doesNotMatch(exit(render(false)),/href="#store-data-export"/);
});
test('every existing export visibility restriction also hides the exit link',()=>{
  for(const props of [{closing:true},{standing:'ended'},{standing:'none'},{canExport:false}]){
    const html=renderToStaticMarkup(React.createElement(ExitSource,props));
    assert.doesNotMatch(html,/href="#store-data-export"|id="store-data-export"/);
  }
});
test('the exit reuses the existing export and adds no download request or cancel step',()=>{
  const html=render();
  assert.equal((html.match(/action="\/api\/store\/export"/g)??[]).length,1);
  assert.equal((exit(html).match(/<form\b/g)??[]).length,1);
  assert.doesNotMatch(exit(html),/action="\/api\/store\/export"/);
  assert.equal(exit(renderToStaticMarkup(React.createElement(ExitSource,{subscriptionId:''}))), '');
});
