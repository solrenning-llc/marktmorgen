import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyCheckoutFields,PHONE_LABEL,type CheckoutField} from '@/lib/checkout-fields';
import {captureCheckoutQuestions} from '@/lib/checkout-question-candidate';
const schema=():CheckoutField[]=>[
 {label:'Name on the print',type:'text',optional:false,options:[]},
 {label:'Size',type:'dropdown',optional:true,options:['Small','Large']},
 {label:PHONE_LABEL,type:'phone',optional:false,options:[]},
];
function body(fields=schema()){const form=new URLSearchParams({mode:'payment','metadata[product]':'original'});applyCheckoutFields(form,fields);return form;}
test('captures exact canonical original questions and native phone collection without admission',()=>{
 const fields=schema(),form=body(fields),c=captureCheckoutQuestions(fields,form.toString(),60000);assert.ok(c);
 assert.equal(c.admitted,false);assert.deepEqual(c.fields,fields);assert.equal(Object.isFrozen(c),true);
 assert.equal(c.projection.some(([k,v])=>k==='phone_number_collection[enabled]'&&v==='true'),true);
 assert.equal(c.projection.some(([k])=>k.startsWith('metadata')),false);
});
test('later edits and removed questions cannot rewrite the captured schema',()=>{
 const fields=schema(),c=captureCheckoutQuestions(fields,body(fields).toString(),60000);assert.ok(c);const original=JSON.stringify(c);
 fields[1].options[0]='Replaced';fields[0].label='Changed';fields.splice(1);assert.equal(JSON.stringify(c),original);
 assert.equal(c.fields[1].options[0],'Small');assert.equal(Object.isFrozen(c.fields[1].options),true);
});
test('changed label, required status, dropdown choice, missing and extra provider fields refuse',()=>{
 for(const [key,value] of [['custom_fields[0][label][custom]','Changed'],['custom_fields[0][optional]','true'],
  ['custom_fields[1][dropdown][options][0][value]','different'],['custom_fields[2][key]','extra'],['phone_number_collection[enabled]','false']]){
  const form=body();form.set(key,value);assert.equal(captureCheckoutQuestions(schema(),form.toString(),60000),null);
 }
 const form=body();form.delete('custom_fields[0][key]');assert.equal(captureCheckoutQuestions(schema(),form.toString(),60000),null);
});
test('equal duplicate keys are ambiguous too; unrelated payment metadata is not a question',()=>{
 const form=body();form.append('custom_fields[0][key]','question1');assert.equal(captureCheckoutQuestions(schema(),form.toString(),60000),null);
 const unrelated=body();unrelated.append('metadata[other]','original');assert.ok(captureCheckoutQuestions(schema(),unrelated.toString(),60000));
});
test('schema normalization cannot silently truncate, omit or change original rights',()=>{
 for(const fields of [[],[...schema(),schema()[0]],schema().map(f=>({...f,label:' '+f.label})),
  [{...schema()[1],options:['Same','same']}],[{...schema()[0],options:['unexpected']}],
  [{label:PHONE_LABEL,type:'phone',optional:true,options:[]}],[schema()[2],schema()[2]]])
  assert.equal(captureCheckoutQuestions(fields,body().toString(),60000),null);
});
test('bounded UTF8 envelope denies unknown and insufficient processing limits',()=>{
 const fields=[{label:'Tên trên quà',type:'text' as const,optional:false,options:[]}],form=body(fields).toString();
 const c=captureCheckoutQuestions(fields,form,60000);assert.ok(c);
 for(const cap of [0,-1,NaN,Infinity,'60000',131073,form.length-1])assert.equal(captureCheckoutQuestions(fields,form,cap),null);
 assert.ok(captureCheckoutQuestions(fields,form,Math.max(Buffer.byteLength(form),Buffer.byteLength(JSON.stringify(c)))));
});
test('descriptor-backed fields, options and array entries never execute code',()=>{
 let reads=0;
 for(const which of ['field','option','array']){
  const fields=schema();
  if(which==='field')Object.defineProperty(fields[0],'label',{get(){reads++;throw Error('no');}});
  if(which==='option')Object.defineProperty(fields[1].options,'0',{get(){reads++;throw Error('no');}});
  if(which==='array')Object.defineProperty(fields,'0',{get(){reads++;throw Error('no');}});
  assert.equal(captureCheckoutQuestions(fields,body().toString(),60000),null);
 }
 assert.equal(reads,0);
});
test('numeric questions preserve their required status and question position',()=>{
 const fields:CheckoutField[]=[{label:'Edition number',type:'numeric',optional:false,options:[]}];
 const c=captureCheckoutQuestions(fields,body(fields).toString(),60000);assert.ok(c);assert.deepEqual(c.fields,fields);
 const form=body(fields);form.set('custom_fields[0][type]','text');assert.equal(captureCheckoutQuestions(fields,form.toString(),60000),null);
});
