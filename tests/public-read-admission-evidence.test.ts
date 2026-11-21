/**
 * Codex G2 on #2583, kept as permanent tests: a license check pays before it reads the product, and only Redis's own
 * answer to the count pays; a collection pays for the items its bundles hold, once known, before it reads them, as the
 * page does (bundleItemsToRead, bundleItemUnits). Real license handler and collection readers; synthetic Redis.
 */
import assert from 'node:assert/strict';import test from 'node:test';import{NextRequest}from'next/server';
import{GET}from'@/app/api/store/licence/route';
import{addProduct,addCopiedProducts,claimHandle,ensureStatsId,setProductLink,setProductBundle,setProductHidden,setSubscription,storeForEmail}from'@/lib/store';
import{readProduct,readListings}from'@/lib/catalog';import{bundleItemsToRead,offeredItems}from'@/lib/bundles';
import{requestLimitFor}from'@/lib/traffic-rules';
import{isResting,takePublicRequest}from'@/lib/traffic';import{bundleItemUnits,collectionUnits}from'@/lib/page-read-rules';
import{laterPageCost}from'./traffic-cost';import{COMMAND}from'./plan-cost-registry';import{store as redis}from'./redis-stub';import{paidPeriod}from'./billing-period-fixture';
async function seed(){redis.clear();const owner='publicg2@example.test';assert.equal((await claimHandle(owner,'publicg2','Synthetic shop','')).ok,true);await ensureStatsId(owner);const paid=await setSubscription(owner,{customerId:'cus_PublicG2',subscriptionId:'sub_PublicG2',active:true,tier:'scale',period:paidPeriod()});assert.ok(paid?.subscriptionActive);const made=await addProduct(owner,'Synthetic product','','19',null);assert.ok(made.ok);assert.ok((await setProductHidden(owner,made.product.id,true)).ok);const store=await storeForEmail(owner);assert.ok(store?.statsId);return{owner,store,id:made.product.id};}
function request(id:string){return new NextRequest(`https://marktmorgen.com/api/store/licence?store=publicg2&product=${id}&key=ABCD-EFGH-IJKL-MNOP`,{headers:{'x-forwarded-for':'198.51.100.20'}});}
test('G2 known license reservation precedes the actual cold product read',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);const calls:(string|number)[][]=[];
 redis.pipeline=async commands=>{calls.push(...commands);return original(commands);};let response;
 try{response=await GET(request(s.id));}finally{redis.pipeline=original;}
 assert.equal(response.status,200);const paid=calls.findIndex(c=>c[0]==='INCRBY'&&String(c[1]).startsWith('nl:traffic:r:')),read=calls.findIndex(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:catalog:'));
 assert.ok(paid>=0&&read>paid,JSON.stringify({paid,read}));
});
test('G2 a genuinely exhausted window refuses before any cold product read',async()=>{
 const s=await seed();assert.equal(await takePublicRequest(s.store,'buyer',undefined,requestLimitFor(s.store)),true);
 const original=redis.pipeline.bind(redis);let reads=0;redis.pipeline=async commands=>{reads+=commands.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:catalog:')).length;return original(commands);};
 let response;try{response=await GET(request(s.id));}finally{redis.pipeline=original;}assert.equal(response.status,429);assert.equal(reads,0);
});
for(const receipt of [[true],[1,0]])test('G2 unknown unpaid reservation cannot authorize license product/key reads '+JSON.stringify(receipt),async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);let charged=0,productReads=0,requestKey="";
 redis.pipeline=async commands=>{if(commands.some(c=>c[0]==='INCRBY'&&String(c[1]).startsWith('nl:traffic:r:'))){charged++;requestKey=String(commands.find(c=>c[0]==='INCRBY')![1]);return receipt as never;}productReads+=commands.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:catalog:')).length;return original(commands);};
 let response;try{response=await GET(request(s.id));}finally{redis.pipeline=original;}
 assert.equal(charged,1);assert.equal(redis.run(['GET',requestKey]),null);assert.equal(productReads,0,JSON.stringify({status:response.status,productReads,receipt}));assert.ok(response.status>=400,'unknown reservation must deny the request');
});
test('G2 four legal bundles fit the actual two public requests paid before their readers',async()=>{
 const s=await seed();assert.ok((await setProductLink(s.owner,s.id,'https://example.test/delivery')).ok);let current=await storeForEmail(s.owner);assert.ok(current);const base=await readProduct(current,s.id);assert.ok(base);
 const children=Array.from({length:80},(_,i)=>({...base,id:`child${String(i).padStart(7,'0')}`,title:`Synthetic item ${i}`,createdAt:base.createdAt+i}));
 const copied=await addCopiedProducts(s.owner,children);assert.ok(copied.ok);assert.equal(copied.made.length,80);
 assert.ok((await setProductHidden(s.owner,s.id,true)).ok);
 const ids:string[]=[];for(let n=0;n<4;n++){const p=await addProduct(s.owner,`Synthetic bundle ${n}`,'','19',null);assert.ok(p.ok);assert.ok((await setProductBundle(s.owner,p.product.id,children.slice(n*20,n*20+20).map(c=>c.id))).ok);ids.push(p.product.id);}
 current=await storeForEmail(s.owner);assert.ok(current);assert.equal(current.catalog.inline,null);
 const original=redis.pipeline.bind(redis);let paidUnits=0,gets=0;
 redis.pipeline=async commands=>{for(const c of commands){if(c[0]==='INCRBY'&&String(c[1]).startsWith('nl:traffic:r:'))paidUnits+=Number(c[2]);if(c[0]==='GET'&&String(c[1]).startsWith('nl:catalog:'))gets++;}return original(commands);};
 try{assert.equal(await isResting(current),false);assert.equal(await takePublicRequest(current,'public',undefined,collectionUnits(ids.length)),true);const products=await readListings(current,ids);assert.equal(products.length,4);const items=bundleItemsToRead(products);assert.equal(items.length,80);assert.equal(await takePublicRequest(current,'public',undefined,bundleItemUnits(items.length)),true);const offered=await offeredItems(current,products);assert.equal([...offered.values()].reduce((n,a)=>n+a.length,0),80);}finally{redis.pipeline=original;}
 assert.equal(paidUnits,2+bundleItemUnits(80));assert.ok(gets>=80,JSON.stringify({gets,head:current.catalog.head.map(p=>p.id)}));const lowerBound=gets*COMMAND,budget=paidUnits*laterPageCost();assert.ok(lowerBound<=budget,JSON.stringify({gets,lowerBound,budget,paidUnits}));
});
