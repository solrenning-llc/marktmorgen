import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextRequest } from 'next/server';
import Page from '@/app/studio/forms/page';
import EmailPage from '@/app/studio/email/page';
import { GET as csv } from '@/app/api/store/forms/export/route';
import { GET as pdf } from '@/app/api/store/forms/response-pdf/route';
import { POST as opportunity } from '@/app/api/store/form-opportunity/route';
import { state } from './form-response-unavailable-world';
import { POST as saveForm } from '@/app/api/store/forms/route';
import { form } from './form-response-fixture';
const request=()=>Object.assign(new Request('https://example.com/?id=form000001&response='+'a'.repeat(32)),{nextUrl:new URL('https://example.com/?id=form000001&response='+'a'.repeat(32))}) as unknown as NextRequest;
test('one unknown form keeps both editable cards usable without a false count',async()=>{
 state.unavailable=true;const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 assert.match(html,/Answers could not be read right now/);assert.match(html,/Healthy form/);assert.match(html,/Edit/);assert.doesNotMatch(html,/0 answers kept/);
 assert.match(html,/4 answers kept/);
});
for(const [name,handler] of [['CSV',csv],['PDF',pdf],['opportunity',opportunity]] as const){
 test(name+' reports unavailable rather than an empty file or response gone',async()=>{state.unavailable=true;const r=await handler(request());assert.equal(r.status,503);assert.match(await r.text(),/unavailable/);assert.equal(r.headers.get('content-disposition'),null);assert.equal(state.pdf,0);assert.equal(state.writes,0);});
}
test('confirmed known CSV and PDF keep their successful downloads',async()=>{state.unavailable=false;for(const fn of [csv,pdf]){const r=await fn(request());assert.equal(r.status,200);assert.match(r.headers.get('content-disposition')??'',/attachment/);}state.pdf=0;});
test('permission refusal stays before the response read',async()=>{state.denied=true;state.unavailable=true;for(const fn of [csv,pdf,opportunity])assert.equal((await fn(request())).status,403);state.denied=false;});

for(const [name,handler] of [['CSV',csv],['PDF',pdf]] as const){
 test(name+' reports an unreadable definition as unavailable',async()=>{
  state.definitionsUnavailable=true;
  try{const r=await handler(request());assert.equal(r.status,503);assert.match(await r.text(),/unavailable/);assert.equal(r.headers.get('content-disposition'),null);}
  finally{state.definitionsUnavailable=false;}
 });
}
for(const remove of [false,true]){
 test((remove?'deletion':'editing')+' returns 503 for an unknown form receipt',async()=>{
  state.body=remove?{action:'remove',id:form.id}:{form};
  state.definitionsUnavailable=!remove;state.deletionUnavailable=remove;state.writes=0;
  try{const r=await saveForm(request());assert.equal(r.status,503);assert.equal((await r.json()).error,'unavailable');assert.equal(state.writes,0);}
  finally{state.body=null;state.definitionsUnavailable=false;state.deletionUnavailable=false;}
 });
}

for(const [name,handler] of [['CSV',csv],['PDF',pdf]] as const){
 test(name+' keeps confirmed absence distinct from unavailable',async()=>{
  state.missing=true;
  try{const r=await handler(request());assert.equal(r.status,404);assert.equal(r.headers.get('content-disposition'),null);}
  finally{state.missing=false;}
 });
}

test('unknown form inventory has a status notice and no empty editable inventory',async()=>{
 state.inventoryUnavailable=true;
 try{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
  assert.match(html,/Forms could not be read right now/);
  assert.match(html,/role="status"/);
  assert.doesNotMatch(html,/New form/);
 }finally{state.inventoryUnavailable=false;}
});

for(const remove of [false,true]){
 test((remove?'confirmed deletion':'healthy editing')+' remains successful',async()=>{
  state.body=remove?{action:'remove',id:form.id}:{form};state.writes=0;
  try{const r=await saveForm(request());assert.equal(r.status,200);assert.equal((await r.json()).ok,true);assert.equal(state.writes,1);}
  finally{state.body=null;state.writes=0;}
 });
}
test('CRUD permission refusal stays before any form mutation',async()=>{
 state.denied=true;state.writes=0;
 try{assert.equal((await saveForm(request())).status,403);assert.equal(state.writes,0);}
 finally{state.denied=false;}
});


type EmailPageProps={flowsReadFailed:boolean;initialSequence?:unknown;automation:{forms:{id:string}[]}};
async function emailPage(forms:'known'|'unknown'|'empty',allowance=1,sequenceTemplate?:string){
 state.emailForms=forms;state.emailAllowance=allowance;state.formReads=0;state.emailProps=null;
 try{
  const html=renderToStaticMarkup(await EmailPage({searchParams:Promise.resolve(sequenceTemplate?{sequenceTemplate}:{})}));
  return {html,props:state.emailProps as EmailPageProps|null,reads:state.formReads};
 }finally{state.emailForms='known';state.emailAllowance=1;}
}
test('email page reports unavailable form choices and blocks sequence mutation',async()=>{
 const result=await emailPage('unknown');
 assert.match(result.html,/Forms could not be checked/);
 assert.match(result.html,/role="status"/);
 assert.ok(result.props);
 assert.equal(result.props.flowsReadFailed,true);
 assert.equal(result.reads,1);
});
test('email page does not promise an opened sequence when its forms are unknown',async()=>{
 const result=await emailPage('unknown',1,'welcome');
 assert.ok(result.props);
 assert.equal(result.props.initialSequence,undefined);
 assert.doesNotMatch(result.html,/Library sequence opened as an unsaved paused draft/);
 assert.equal(result.reads,1);
});
test('email page preserves confirmed form choices',async()=>{
 const result=await emailPage('known');
 assert.ok(result.props);
 assert.equal(result.props.flowsReadFailed,false);
 assert.ok(result.props.automation.forms.some(item=>item.id===form.id));
 assert.doesNotMatch(result.html,/Forms could not be checked/);
 assert.equal(result.reads,1);
});
test('email page preserves a confirmed empty form inventory',async()=>{
 const result=await emailPage('empty');
 assert.ok(result.props);
 assert.equal(result.props.flowsReadFailed,false);
 assert.deepEqual(result.props.automation.forms,[]);
 assert.doesNotMatch(result.html,/Forms could not be checked/);
 assert.equal(result.reads,1);
});
test('email page still skips the form read when its editor is not shown',async()=>{
 const result=await emailPage('unknown',0);
 assert.equal(result.props,null);
 assert.equal(result.reads,0);
});
