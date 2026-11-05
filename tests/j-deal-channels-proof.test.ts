import assert from 'node:assert/strict';
import {saleChannel} from '@/lib/stats';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {dealsByChannel} from '@/lib/deal-channels';
import {DEFAULT_STAGES,type Deal} from '@/lib/crm-rules';
import {DealChannelsTable,DealChannelsLoader} from '@/components/deal-channels-table';
import {store as redis} from './redis-stub';
import type {Store} from '@/lib/store';
globalThis.fetch=(async()=>{throw new Error('No provider calls in cached ledger proof');}) as typeof fetch;
const deal=(id:string,email:string):Deal=>({id,title:id,email,cents:10000,stage:'won000',note:'',createdAt:1,updatedAt:1});
test('a valid named campaign cannot merge with an unbought-person sentinel',()=>{
 const source=saleChannel({utm_source:'not-a-buyer'}).first;
 assert.equal(source,'not-a-buyer','actual sale-channel reader accepts the campaign');
 const result=dealsByChannel([deal('one','buyer@example.com'),deal('two','new@example.com')],DEFAULT_STAGES,email=>email==='buyer@example.com'?source:null);
 console.log('SENTINEL',JSON.stringify(result));
 assert.equal(result.rows.length,2,'a real campaign and not-a-buyer are distinct channels');
});
test('partial sales cannot definitively classify an absent buyer as never having bought',async()=>{
 redis.clear();
 const shop={sid:'sidbake00001',handle:'bakery',previousHandles:[],releasedHandles:[],statsId:'s'.repeat(32),listId:'list0001',currency:'usd',stripeAccountId:'acct_test_segments1',catalog:{id:null,head:[],items:[],inline:[]}} as unknown as Store;
 await redis.pipeline([['SET',`nl:stats:${shop.statsId}:ledger`,JSON.stringify({c:'usd',p:true,r:[],v:6})]]);
 const element=await DealChannelsLoader({store:shop,deals:[deal('three','buyer@example.com')],stages:DEFAULT_STAGES});
 const html=renderToStaticMarkup(element);
 assert.match(html,/Some of your sales could not be read/);
 console.log('PARTIAL_LABEL',html.includes('Has not bought yet'));
 assert.doesNotMatch(html,/>Has not bought yet</,'missing from partial ledger is unknown, not non-buyer');
});
