import { membershipStatus, isLive } from '@/lib/membership-access';
import { UnknownReplyError } from '@/lib/redis-reply';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';
import { done, is } from './check';
const store = {stripeAccountId:'acct_GMemberProof'} as Store;
const sub = 'sub_GMember000001';
const key = `nl:member:status:${store.stripeAccountId}:${sub}`;
const original = redis.pipeline.bind(redis);
let body: unknown = {id:sub,status:'active',pause_collection:null};
let status = 200, requests = 0;
globalThis.fetch = (async (input: string|URL|Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if(url.hostname!=='api.stripe.com'||url.pathname!==`/v1/subscriptions/${sub}`||init?.method!=='GET')throw new Error('Unexpected provider operation');
  requests++;
  return new Response(JSON.stringify(body),{status});
}) as typeof fetch;
async function main() {
  process.env.STRIPE_SECRET_KEY='sk_test_Gmemberproof_only';
  redis.clear();
  is('confirmed identity allows known active status',[await membershipStatus(store,sub),requests],['active',1]);
  is('confirmed cached status avoids a second provider request',[await membershipStatus(store,sub),requests],['active',1]);
  const inherited = Array(1);
  Object.setPrototypeOf(inherited,Object.assign(Object.create(Array.prototype),{0:'active'}));
  for (const reply of [Array(1),inherited]) {
    redis.clear();requests=0;
    // Avoid spreading the sparse array: its missing/inherited slot is the
    // exact boundary under test.
    redis.pipeline=async commands=>commands[0]?.[0]==='GET'?reply:original(commands);
    let error: unknown;try{await membershipStatus(store,sub);}catch(caught){error=caught;}
    is('sparse or inherited cache slot is unknown and does not call the provider',[error instanceof UnknownReplyError,requests],[true,0]);
  }
  redis.pipeline=original;
  for (const reply of [{status:'active',pause_collection:null},{id:'sub_Different000001',status:'active',pause_collection:null}]) {
    redis.clear();requests=0;body=reply;
    let error: unknown;try{await membershipStatus(store,sub);}catch(caught){error=caught;}
    const [cached]=await original([['GET',key]]);
    is('unconfirmed or different provider identity is unknown and cannot cache requested membership',[error instanceof UnknownReplyError,cached,requests],[true,null,1]);
  }
  redis.clear();requests=0;body={error:{message:'Synthetic provider unavailable'}};status=503;
  let threw=false;try{await membershipStatus(store,sub);}catch{threw=true;}
  is('provider error stays unavailable without cached access',[threw,(await original([['GET',key]]))[0],requests],[true,null,1]);
  redis.clear();requests=0;body={id:sub,status:'canceled',pause_collection:null};status=200;
  is('confirmed canceled membership stays denied',isLive(await membershipStatus(store,sub)),false);
  redis.pipeline=original;
  done();
}
main().catch(error=>{redis.pipeline=original;console.error(error);process.exit(1);});
