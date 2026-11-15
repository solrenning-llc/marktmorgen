import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {isValidElement,type ReactNode} from 'react';
import {NextRequest} from 'next/server';
import DeletePage from '@/app/privacy/delete/page';
import {POST} from '@/app/api/privacy/erase/route';
import {claimHandle,ensureListId,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {upsertContact} from '@/lib/contacts';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {paidPeriod} from './billing-period-fixture';
function inspect(node:ReactNode,result={text:'',confirms:0}):typeof result{
 if(Array.isArray(node)){for(const child of node)inspect(child,result);return result;}
 if(typeof node==='string'||typeof node==='number'){result.text+=String(node);return result;}
 if(!isValidElement<{children?:ReactNode;name?:string;value?:string}>(node))return result;
 if(node.type==='input'&&node.props.name==='action'&&node.props.value==='confirm')result.confirms++;
 inspect(node.props.children,result);return result;
}
async function scenario(){
 redis.clear();const original=redis.pipeline.bind(redis);const keyBefore=process.env.NIMBUS_DATA_KEY;
 process.env.NIMBUS_DATA_KEY='synthetic-preview-evidence-key-32-characters';
 globalThis.fetch=async()=>{throw Error('No external request allowed');};
 try{
  const owner='preview-owner@example.com',email='preview-person@example.com',token='d'.repeat(64);
  await claimHandle(owner,'previewproof','Preview Proof','');await ensureStoreId(owner);await ensureStatsId(owner);await ensureListId(owner);
  await setSubscription(owner,{customerId:'cus_preview_proof',subscriptionId:'sub_preview_proof',active:true,tier:'pro',period:paidPeriod()});
  const store=(await storeForEmail(owner))!;await upsertContact(store.listId!,email,{agreed:true,explicit:true,source:'free'},ROOM);
  const key='nl:erase:link:'+createHash('sha256').update('nimbus-erase-link:'+token).digest('hex').slice(0,40);
  const grant=JSON.stringify({e:email,s:[store.sid]});await original([['SET',key,grant,'EX',3600]]);
  const show=async(query:Record<string,string>)=>inspect(await DeletePage({searchParams:Promise.resolve(query)}));
  const normal=await show({token});
  redis.pipeline=async commands=>commands.some(c=>c[0]==='GET'&&c[1]==='nl:store:id:'+store.sid)?[]:original(commands);
  const unavailable=await show({token});
  const response=await POST(new NextRequest('https://marktmorgen.com/api/privacy/erase',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://marktmorgen.com',host:'marktmorgen.com'},body:new URLSearchParams({action:'confirm',token})}));
  const destination=new URL(response.headers.get('location')!);const query=Object.fromEntries(destination.searchParams);
  const afterPost=await show(query);const retained=redis.run(['GET',key]);
  redis.pipeline=original;const recovered=await show(query);await original([['DEL',key]]);const expired=await show({token});
  return {normal,unavailable,afterPost,recovered,expired,retained,grant,status:query.status};
 }finally{redis.pipeline=original;if(keyBefore===undefined)delete process.env.NIMBUS_DATA_KEY;else process.env.NIMBUS_DATA_KEY=keyBefore;}
}
const results=scenario();
test('confirmed live scope and genuinely expired grant have distinct normal controls',async()=>{const r=await results;assert.equal(r.normal.confirms,1);assert.match(r.expired.text,/That link has run out/);assert.equal(r.expired.confirms,0);});
test('an unreadable store does not label a retained live grant expired',async()=>{const r=await results;assert.doesNotMatch(r.unavailable.text,/That link has run out or was already used/);});
test('the real pending redirect preserves the promised pending result on the actual page',async()=>{const r=await results;assert.equal(r.status,'more');assert.equal(r.retained,r.grant);assert.match(r.afterPost.text,/The rest could not be finished just now/);assert.doesNotMatch(r.afterPost.text,/That link has run out or was already used/);});
test('the same URL and grant work after the store recovers',async()=>{const r=await results;assert.equal(r.recovered.confirms,1);assert.match(r.recovered.text,/The rest could not be finished just now/);});
