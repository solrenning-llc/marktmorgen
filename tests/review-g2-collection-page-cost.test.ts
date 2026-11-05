/** Invoke the actual async server page; no helper reimplementation and no browser/HTML certification. */
import assert from 'node:assert/strict';
import test from 'node:test';
import Page from '@/app/[handle]/shop/[collection]/page';
import {StoreResting} from '@/components/store-resting';
import {addProduct,addCopiedProducts,claimHandle,ensureStatsId,setCollections,setProductLink,setProductBundle,setProductHidden,setSubscription,storeForEmail} from '@/lib/store';
import {readProduct} from '@/lib/catalog';
import {collectionSegment} from '@/lib/store-collections';
import {requestLimitFor,publicVisitLimit} from '@/lib/traffic-rules';
import {takePublicRequest} from '@/lib/traffic';
import {laterPageCost} from './traffic-cost';
import {COMMAND} from './plan-cost-registry';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
async function seed(){
 redis.clear();const owner='g2pagecost@example.test';assert.equal((await claimHandle(owner,'g2pagecost','Synthetic shop','')).ok,true);await ensureStatsId(owner);
 await setSubscription(owner,{customerId:'cus_G2Page',subscriptionId:'sub_G2Page',active:true,tier:'scale',period:paidPeriod()});
 const made=await addProduct(owner,'Synthetic download','','19',null);assert.ok(made.ok);assert.ok((await setProductHidden(owner,made.product.id,true)).ok);assert.ok((await setProductLink(owner,made.product.id,'https://example.test/delivery')).ok);
 let current=await storeForEmail(owner);assert.ok(current);const base=await readProduct(current,made.product.id);assert.ok(base);
 const children=Array.from({length:80},(_,i)=>({...base,id:`pagechild${String(i).padStart(4,'0')}`,title:`Synthetic page item ${i}`,createdAt:base.createdAt+i}));
 const copied=await addCopiedProducts(owner,children);assert.ok(copied.ok);assert.equal(copied.made.length,80);
 const ids:string[]=[];for(let n=0;n<4;n++){const p=await addProduct(owner,`Synthetic bundle ${n}`,'','19',null);assert.ok(p.ok);assert.ok((await setProductBundle(owner,p.product.id,children.slice(n*20,n*20+20).map(c=>c.id))).ok);ids.push(p.product.id);}
 const collection={id:'g2page01',title:'Synthetic collection',blurb:'',products:ids};assert.ok((await setCollections(owner,[collection])).ok);
 current=await storeForEmail(owner);assert.ok(current);assert.ok(current.collections);assert.equal(current.collections.length,1);return{store:current,segment:collectionSegment(current.collections[0])};
}
for(const exhausted of [false,true])test(`actual collection page ${exhausted?'rests without reading bundle items when added admission is refused':'funds all 80 cold bundle item reads'}`,async()=>{
 const s=await seed();if(exhausted)assert.equal(await takePublicRequest(s.store,'public',undefined,publicVisitLimit(requestLimitFor(s.store))-4,{shared:true}),true);
 const original=redis.pipeline.bind(redis);let paidUnits=0,children=0;const sequence:string[]=[];
 redis.pipeline=async commands=>{for(const c of commands){if(c[0]==='INCRBY'&&String(c[1]).startsWith('nl:traffic:r:')){paidUnits+=Number(c[2]);sequence.push('pay:'+c[2]);}if(c[0]==='GET'&&String(c[1]).startsWith('nl:catalog:')&&String(c[1]).includes('pagechild')){children++;sequence.push('item');}}return original(commands);};
 const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};let result;try{result=await Page({params:Promise.resolve({handle:'@g2pagecost',collection:s.segment})});}finally{redis.pipeline=original;globalThis.fetch=fetchBefore;}
 console.log('G2_ACTUAL_COLLECTION_PAGE',JSON.stringify({exhausted,paidUnits,children,sequence:sequence.slice(0,9)}));
 if(exhausted){assert.equal(result.type,StoreResting);assert.equal(children,0);}else{assert.notEqual(result.type,StoreResting);assert.equal(children,80);assert.ok(children*COMMAND<=paidUnits*laterPageCost());assert.ok(sequence.indexOf('pay:5')>=0&&sequence.indexOf('pay:5')<sequence.indexOf('item'));}
});
