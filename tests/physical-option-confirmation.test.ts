/** Recovery of the pure selection slice only; no paid73h/source/worker proof. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedPhysicalOption} from '@/lib/physical-option-confirmation';
const option=()=>({id:'large_print',label:'Large print',priceCents:6500,file:null,link:null,details:['Printed edition'],best:false});
const select=(o:unknown)=>selectedPhysicalOption({options:[o]},'large_print');
test('captures only the selected physical identity and makes a detached description copy',()=>{
 const o=option(),c=select(o);assert.ok(c);assert.deepEqual(c,o);assert.notEqual(c,o);assert.notEqual(c.details,o.details);
 o.label='Changed catalog';o.priceCents=1;o.details[0]='Replaced';assert.equal(c.label,'Large print');assert.equal(c.priceCents,6500);assert.deepEqual(c.details,['Printed edition']);
 c.details[0]='Changed copy';assert.deepEqual(o.details,['Replaced']);
});
test('a zero-priced physical choice stays zero without inventing its shipping or paid total',()=>{
 const c=select({...option(),priceCents:0});assert.ok(c);assert.equal(c.priceCents,0);assert.equal(Object.hasOwn(c,'shipping'),false);
 assert.equal(Object.hasOwn(c,'permitsCheckout'),false);
});
test('missing, ambiguous and unknown selected IDs never fall back to the first choice',()=>{
 const o=option();for(const p of [{options:[]},{options:[o,o]},{options:[o,{...o,id:'another'}]}])assert.equal(selectedPhysicalOption(p,o.id),null);
 for(const id of ['another','',null,0,'x'.repeat(25)])assert.equal(selectedPhysicalOption({options:[o]},id),null);
});
test('noncanonical amounts cannot coerce themselves into a price',()=>{
 for(const priceCents of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'6500',null,{},6500.5])assert.equal(select({...option(),priceCents}),null);
});
test('file/link delivery, SKU-coupled and extra option properties stay outside this projection',()=>{
 for(const patch of [{file:{pathname:'a.pdf'}},{link:'https://example.test'},{sku:'physical-stock'},{extra:true}])assert.equal(select({...option(),...patch}),null);
 const missing={...option()} as Partial<ReturnType<typeof option>>;delete missing.best;assert.equal(select(missing),null);
});
test('identity, label and description bounds retain the existing option contract',()=>{
 for(const patch of [{id:'bad id'},{label:''},{label:' '},{label:'x'.repeat(41)},{label:'Bad\nlabel'},
  {details:['x'.repeat(101)]},{details:Array(9).fill('line')},{details:['bad\0line']},{best:'yes'}])assert.equal(select({...option(),...patch}),null);
 assert.ok(select({...option(),label:'x'.repeat(40),details:Array(8).fill('x'.repeat(100))}));
});
test('getters in selected fields and descriptions are refused without execution',()=>{
 let reads=0;const o=Object.defineProperty(option(),'label',{get(){reads++;throw Error('no');}});assert.equal(select(o),null);
 const d=option();Object.defineProperty(d.details,'0',{get(){reads++;throw Error('no');}});assert.equal(select(d),null);
 const a=[option()];Object.defineProperty(a,'0',{get(){reads++;throw Error('no');}});assert.equal(selectedPhysicalOption({options:a},'large_print'),null);assert.equal(reads,0);
});
test('inherited, sparse and non-array projections cannot hide an unknown option',()=>{
 assert.equal(select(Object.create(option())),null);const a=[option()];delete a[0];assert.equal(selectedPhysicalOption({options:a},'large_print'),null);
 for(const p of [null,[],{options:{0:option(),length:1}},{options:false}])assert.equal(selectedPhysicalOption(p,'large_print'),null);
});
