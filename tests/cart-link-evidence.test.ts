// Codex G2's proof on #1928 (624 [SZ8](23), head 8a04da813, branch codex/g2-review-1928-cart-link-red at 9a02bebde), kept as permanent tests.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {offersCart} from '@/lib/cart-checkout';import {cartLinkProducts} from '@/lib/cart-link-products';
import {addDraftProducts,claimHandle,ensureStatsId,setSubscription,setProductHidden,storeForEmail} from '@/lib/store';
import {productIds} from '@/lib/catalog';import {countStudio} from '@/lib/studio-route';import {STUDIO_PAGE_UNITS} from '@/lib/studio-allowance-rules';
import {paidPeriod} from './billing-period-fixture';import {store as redis} from './redis-stub';
globalThis.fetch=async()=>{throw Error('No external service in G2 review');};
test('ready-cart listing reads must fit the actual studio page admission before their reads',async()=>{
 redis.clear();const email='g2-cart-link-cost@example.test';await claimHandle(email,'g2-cart-link-cost','Synthetic store','');await ensureStatsId(email);
 await setSubscription(email,{customerId:'cus_G2CartLink',subscriptionId:'sub_G2CartLink',active:true,tier:'pro',period:paidPeriod()});
 assert.equal((await addDraftProducts(email,Array.from({length:200},(_,i)=>({title:'Guide '+i+' '+'€'.repeat(70),summary:'€'.repeat(300),priceCents:1900,link:'https://example.test/guide'})))).ok,true);
 let shop=(await storeForEmail(email))!;const ids=productIds(shop);assert.equal(ids.length,200);
 for(const id of ids.slice(0,2))assert.equal((await setProductHidden(email,id,false)).ok,true);
 shop=(await storeForEmail(email))!;assert.equal(offersCart(shop),true);
 const base=redis.pipeline.bind(redis);let bytes=0,reads=0,paidBeforeFirst:number|null=null;const debits:number[]=[];
 redis.pipeline=async batch=>{
  if(batch.some(c=>c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1])))&&paidBeforeFirst===null)paidBeforeFirst=debits.reduce((a,b)=>a+b,0);
  const answers=await base(batch);batch.forEach((c,i)=>{if(c[0]==='INCRBY'&&String(c[1]).includes(':studio:'))debits.push(Number(c[2]));if(c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1]))){reads++;bytes+=Buffer.byteLength(String(answers[i]));}});return answers;
 };
 try{
  assert.equal((await countStudio(shop,null,STUDIO_PAGE_UNITS)).ok,true);
  const result=await cartLinkProducts(shop);assert.equal(result.length,2);
  console.log('G2_CART_LINK_COST',JSON.stringify({reads,bytes,debits,paidBeforeFirst,units:STUDIO_PAGE_UNITS}));
  assert.ok(bytes<=50000*(paidBeforeFirst??0),'new helper alone exceeds all studio-page units, excluding other page reads');
 }finally{redis.pipeline=base;}
});
