import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextRequest } from 'next/server';
import Page from '@/app/studio/forms/page';
import { GET as csv } from '@/app/api/store/forms/export/route';
import { GET as pdf } from '@/app/api/store/forms/response-pdf/route';
import { POST as opportunity } from '@/app/api/store/form-opportunity/route';
import { state } from './form-response-unavailable-world';
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
