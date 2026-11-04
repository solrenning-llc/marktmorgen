/** Recovery of the pure selection slice only; no paid73h/source/worker proof. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedPhysicalOption,physicalOptionBodyMatches,physicalOptionCovered} from '@/lib/physical-option-confirmation';
import {shipmentPolicy} from './shipment-mail-outbox-fixture';
import {CURRENT_SHIPMENT_MAIL_POLICY} from '@/lib/shipment-mail-outbox';
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
test('file/link delivery and extra option properties stay outside this projection',()=>{
 for(const patch of [{file:{pathname:'a.pdf'}},{link:'https://example.test'},{extra:true}])assert.equal(select({...option(),...patch}),null);
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


function original(priceCents=6500){
 const selected={...option(),priceCents},product={id:'original_product',title:'Original printed book',priceCents:3500,
  shipping:{cents:500},note:false,fields:[],options:[selected],file:null,link:null};
 const store={handle:'original.store',currency:'usd'},name=`${product.title} (${selected.label})`;
 const body=new URLSearchParams({mode:'payment','metadata[store]':store.handle,'metadata[product]':product.id,
  'metadata[option]':selected.id,'metadata[title]':name,'metadata[mm_order_origin]':'physical-v1',
  'line_items[0][quantity]':'1','line_items[0][price_data][unit_amount]':String(priceCents),
  'line_items[0][price_data][currency]':store.currency,'line_items[0][price_data][product_data][name]':name});
 return {body,snapshot:{store,product},value:()=>({body:body.toString(),snapshot:{store,product}})};
}
test('the original selected amount matches its snapshot even when the parent price differs',()=>{
 for(const cents of [6500,0]){const f=original(cents);assert.equal(physicalOptionBodyMatches(f.value(),60000),true);
  assert.equal(f.snapshot.product.priceCents,3500);assert.equal(f.snapshot.product.options[0].priceCents,cents);}
});
test('product, store, title, quantity, amount and currency cannot be substituted in the original body',()=>{
 for(const [key,value] of [['metadata[store]','replacement'],['metadata[product]','other'],['metadata[option]','other'],
  ['metadata[title]','Other receipt'],['metadata[mm_order_origin]','single-digital-v1'],['line_items[0][quantity]','2'],
  ['line_items[0][price_data][unit_amount]','3500'],['line_items[0][price_data][currency]','eur'],
  ['line_items[0][price_data][product_data][name]','Replacement']]){
  const f=original();f.body.set(key,value);assert.equal(physicalOptionBodyMatches(f.value(),60000),false);
 }
});
test('missing shipping, unknown currency, custom fields and mixed delivery stay outside the snapshot contract',()=>{
 for(const patch of [{shipping:null},{note:true},{fields:[{label:'Question'}]},{file:{pathname:'digital.pdf'}},{course:{id:'course'}},{recurring:{interval:'month'}}]){
  const f=original();Object.assign(f.snapshot.product,patch);assert.equal(physicalOptionBodyMatches(f.value(),60000),false);
 }
 const f=original();f.snapshot.store.currency='USD';assert.equal(physicalOptionBodyMatches(f.value(),60000),false);
});
test('duplicate body keys, extra line items and known additional entitlements are not this original selection',()=>{
 for(const [key,value] of [['line_items[0][quantity]','1'],['line_items[1][quantity]','1'],['discounts[0][coupon]','coupon'],
  ['custom_fields[0][key]','question1'],['optional_items[0][price]','price'],['metadata[gift]','friend@example.test']]){
  const f=original();f.body.append(key,value);assert.equal(physicalOptionBodyMatches(f.value(),60000),false);
 }
});
test('a later snapshot edit cannot reinterpret the unchanged original checkout body',()=>{
 const f=original();f.snapshot.product.options[0].priceCents=1;assert.equal(physicalOptionBodyMatches(f.value(),60000),false);
 const g=original();g.snapshot.product.title='New catalog title';assert.equal(physicalOptionBodyMatches(g.value(),60000),false);
});
test('missing, malformed and noncanonical wire bodies refuse inside the explicit byte envelope',()=>{
 const f=original();for(const body of [null,'mode=payment',f.body.toString().replaceAll('+','%20')])
  assert.equal(physicalOptionBodyMatches({...f.value(),body},60000),false);
 for(const cap of [0,-1,NaN,Infinity,'60000',131073,Buffer.byteLength(f.body.toString())-1])assert.equal(physicalOptionBodyMatches(f.value(),cap),false);
 assert.equal(physicalOptionBodyMatches(f.value(),Buffer.byteLength(f.body.toString())),true);
});
test('descriptor-backed snapshot and store fields are refused without running getters',()=>{
 let reads=0;const f=original();const store=Object.defineProperty({...f.snapshot.store},'currency',{get(){reads++;throw Error('no');}});
 assert.equal(physicalOptionBodyMatches({...f.value(),snapshot:{...f.snapshot,store}},60000),false);
 const v=Object.defineProperty(f.value(),'body',{get(){reads++;throw Error('no');}});assert.equal(physicalOptionBodyMatches(v,60000),false);assert.equal(reads,0);
});


test('express option coverage requires the same quantitative review and original selected body',()=>{
 const f=original(),now=Date.now();
 for(const coveredOrigins of [['physical-option-confirmation'],['single-digital-confirmation','physical-option-confirmation']]){
  const p={...shipmentPolicy(now),coveredOrigins};assert.equal(physicalOptionCovered(f.value(),p,now),true);
  const changed=original();changed.body.set('line_items[0][price_data][unit_amount]','3500');assert.equal(physicalOptionCovered(changed.value(),p,now),false);
 }
 const p={...shipmentPolicy(now),coveredOrigins:['physical-option-confirmation']};
 assert.equal(physicalOptionCovered(original(0).value(),p,now),true,'selected zero remains a structural match, not proof of paid total');
 assert.equal(physicalOptionCovered(f.value(),{...p,admissionsUntil:now},now),true,'the existing admission deadline is inclusive');
 assert.equal(CURRENT_SHIPMENT_MAIL_POLICY,null);assert.equal(physicalOptionCovered(f.value(),CURRENT_SHIPMENT_MAIL_POLICY,now),false);
});
test('generic physical or digital review cannot inherit express option permission',()=>{
 const f=original(),now=Date.now();
 for(const coveredOrigins of [undefined,[],['course-confirmation'],['single-digital-confirmation'],['single-digital-access-renewal'],['unknown'],['physical-option-confirmation','physical-option-confirmation']])
  assert.equal(physicalOptionCovered(f.value(),{...shipmentPolicy(now),coveredOrigins},now),false);
});
test('unfunded, expired, unknown and too-small quantitative envelopes refuse even with the option recipe',()=>{
 const f=original(),now=Date.now(),p={...shipmentPolicy(now),coveredOrigins:['physical-option-confirmation']};
 for(const patch of [{ongoingStorageFunded:false},{admissionsUntil:now-1},{storeBytes:0},{globalBytes:0},{maxPayloadBytes:1},{unexpected:true}])
  assert.equal(physicalOptionCovered(f.value(),{...p,...patch},now),false);
 for(const candidate of [null,{},Object.create(p)])assert.equal(physicalOptionCovered(f.value(),candidate,now),false);
 assert.equal(physicalOptionCovered({...f.value(),snapshot:{}},p,now),false);
});
test('coverage inspection neither executes policy getters nor modifies the original policy/body',()=>{
 const f=original(),now=Date.now(),p={...shipmentPolicy(now),coveredOrigins:['physical-option-confirmation']};
 let reads=0;const executable=Object.defineProperty({...p},'coveredOrigins',{get(){reads++;throw Error('no');}});
 assert.equal(physicalOptionCovered(f.value(),executable,now),false);assert.equal(reads,0);
 const encoded=JSON.stringify(p),body=f.body.toString();Object.freeze(p.coveredOrigins);Object.freeze(p);
 assert.equal(physicalOptionCovered(f.value(),p,now),true);assert.equal(JSON.stringify(p),encoded);assert.equal(f.body.toString(),body);
});
test('closing admissions does not remove express lifetime coverage from existing pending work',()=>{
 const f=original(),now=Date.now(),p={...shipmentPolicy(now),coveredOrigins:['physical-option-confirmation']},later=now+73*3600000;
 assert.equal(physicalOptionCovered(f.value(),p,later),false,'no new admission after the original deadline');
 assert.equal(physicalOptionCovered(f.value(),p,later,false),true,'same reviewed pending lifetime can continue');
 assert.equal(physicalOptionCovered(f.value(),{...p,coveredOrigins:undefined},later,false),false);
});

test('a canonical optional physical SKU is copied without reinterpretation or mutable catalog substitution',()=>{
 for(const sku of ['PRINT-xl_01','Édition-大', 'x'.repeat(64),'']){
  const o={...option(),sku},c=select(o);assert.ok(c);assert.equal(c.sku,sku);assert.notEqual(c,o);
  o.sku='Replacement';assert.equal(c.sku,sku);
 }
 for(const sku of [undefined,null,0,{},'x'.repeat(65),' bad ','bad\nSKU','bad\u0085SKU'])
  assert.equal(select({...option(),sku}),null);
 let reads=0;const o=Object.defineProperty(option(),'sku',{get(){reads++;throw Error('no');}});
 assert.equal(select(o),null);assert.equal(reads,0);
});
