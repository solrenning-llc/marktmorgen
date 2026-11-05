import { recoveryReport } from '@/lib/payment-recovery-report';
import { countKey, monthOf } from '@/lib/dunning-keys';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';
import { done, is } from './check';
const now = Date.parse('2026-11-05T03:00:00Z');
const store = {handle:'g-recovery',previousHandles:[],releasedHandles:[],stripeAccountId:'acct_GreviewOnly',statsId:'g'.repeat(32),currency:'usd'} as unknown as Store;
const cache = `nl:dun:report:${store.statsId}:v2`;
const invoice = {id:'in_Gproof',currency:'usd',amount_paid:1234,attempt_count:2,paid_out_of_band:false,billing_reason:'subscription_cycle',status_transitions:{paid_at:now/1000-60},parent:{subscription_details:{metadata:{store:store.handle}}}};
let data: unknown[] = [invoice];
let requests = 0;
globalThis.fetch = (async (input: string|URL|Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if(url.hostname!=='api.stripe.com'||url.pathname!=='/v1/invoices'||(init?.method??'GET')!=='GET')throw new Error('Unexpected external operation');
  requests++;
  return new Response(JSON.stringify({object:'list',data,has_more:false}),{status:200});
}) as typeof fetch;
async function refused(fresh=true) { try { await recoveryReport(store,fresh,now); return false; } catch { return true; } }
async function main() {
  process.env.STRIPE_SECRET_KEY='sk_test_Greview_only';
  redis.clear();
  const control=await recoveryReport(store,true,now);
  is('confirmed renewed payment is reported with one GET', [control?.recovered,control?.cents,control?.complete,requests],[1,1234,true,1]);
  redis.clear();data=[];
  const zero=await recoveryReport(store,true,now);
  is('confirmed empty page remains complete zero',[zero?.recovered,zero?.cents,zero?.complete],[0,0,true]);
  for(const billing_reason of ['not_a_stripe_reason','__proto__','']) {
    redis.clear(); data=[{...invoice,billing_reason}];
    const rejected=await refused();
    const [cached]=await redis.pipeline([['GET',cache]]);
    is(`unknown billing reason ${JSON.stringify(billing_reason)} cannot certify/cache recovered revenue`,[rejected,cached===null],[true,true]);
  }
  redis.clear();data=[];
  await redis.pipeline([['HSET',countKey(store.statsId!,monthOf(now)),'failed',String(Number.MAX_SAFE_INTEGER),'cards','2']]);
  const sumRejected=await refused();
  const [cached]=await redis.pipeline([['GET',cache]]);
  is('individually safe counters with unsafe displayed sum do not produce a complete cached report',[sumRejected,cached===null],[true,true]);
  console.log(`UI_SUM ${String(Number.MAX_SAFE_INTEGER+2)} EXACT ${String(BigInt(Number.MAX_SAFE_INTEGER)+BigInt(2))}`);
  redis.clear();
  await redis.pipeline([['SET',cache,JSON.stringify({...control,month:{failed:Number.MAX_SAFE_INTEGER,cards:2}})]]);
  is('same unsafe monthly aggregate is refused from the cache',await refused(false),true);
  redis.clear();
  await redis.pipeline([['HSET',countKey(store.statsId!,monthOf(now)),'failed',String(Number.MAX_SAFE_INTEGER-2),'cards','2']]);
  const edge=await recoveryReport(store,true,now);
  is('largest exact monthly total stays known',(edge?.month.failed??0)+(edge?.month.cards??0),Number.MAX_SAFE_INTEGER);
  done();
}
main().catch(error=>{console.error(error);process.exit(1);});
