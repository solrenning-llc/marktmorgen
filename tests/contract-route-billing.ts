// Everything else of the real module, for what the route reaches through other modules (the closing day, lib/plan-closing.ts); the names below stand in.
export * from '../lib/billing';
import type {ContractGrant} from '@/lib/contract-funding';
export const observations={checkout:[] as ContractGrant[],switches:[] as ContractGrant[],find:0,findFail:false,fail:false,live:null as unknown};
export const resetBilling=()=>{observations.checkout.length=0;observations.switches.length=0;observations.find=0;observations.findFail=false;observations.fail=false;observations.live=null;};
export const isBillingConfigured=()=>true;
export const findStoreSubscriptions=async()=>{observations.find++;if(observations.findFail)throw Error('TEST ONLY subscription search unavailable');return {live:observations.live,customerId:null,lapsed:[]};};
export const endLapsed=async()=>undefined;
export const createBillingCheckout=async(_store:unknown,_origin:unknown,_choice:unknown,_customer:unknown,grant:ContractGrant)=>{observations.checkout.push(grant);if(observations.fail)throw Error('TEST ONLY lost provider response');return 'https://checkout.stripe.test/session';};
export const switchPlan=async(_subscription:unknown,_choice:unknown,grant:ContractGrant)=>{observations.switches.push(grant);return {kind:'confirm',url:'https://invoice.stripe.test/confirm'};};
