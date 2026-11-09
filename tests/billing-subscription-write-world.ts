// Stand-ins for the billing cancel and switch routes (tests/billing-subscription-write.test.ts):
// the studio session, Stripe, the funding reserve, the opening flag and the store write.
// Synthetic only: no network, no Redis, no real subscription.
export const world={
 store:{subscriptionId:"sub_WriteTest0001",subscriptionActive:true,tier:"creator",cycle:"month",statsId:"stats-write-test"} as Record<string,unknown>,
 write:"ok" as "ok"|"null"|"throw",
 writes:[] as unknown[],
 provider:[] as unknown[],
 cancelState:"inactive" as "active"|"inactive",
 cancelRefused:false,
 readState:"inactive" as "active"|"inactive",
 /** How the switch ends: Stripe's confirmed plan, a non-active plan, or a throw before or after the change was sent. */
 switchEnd:"active" as "active"|"inactive"|"unconfirmed"|"refused"|"before",
};
export function resetWorld(){world.write="ok";world.writes.length=0;world.provider.length=0;world.cancelState="inactive";world.cancelRefused=false;world.readState="inactive";world.switchEnd="active";}
export async function creatorFrom(){return {ref:"write-test@example.com",store:world.store,origin:"https://local.example",studio:(query:string)=>"/studio?"+query};}
export function away(origin:string,path:string){return Response.redirect(new URL(path,origin),303);}
export async function limited(request:Request){return request;}
export const isBillingConfigured=()=>true;
export class BillingError extends Error{readonly status:number;readonly code:string;constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}}
export async function setCancelAtPeriodEnd(subscription:string,cancel:boolean){
 world.provider.push(["cancel_at_period_end",subscription,cancel]);
 if(world.cancelRefused)throw new BillingError(400,"resource_missing","TEST ONLY already over");
 return {state:world.cancelState};
}
/** Mirrors lib/billing.ts: a cancel is the same Stripe change; nothing here is past due, so no renewal is voided. */
export async function cancelAndStopUnpaidRenewal(subscription:string){return {state:await setCancelAtPeriodEnd(subscription,true),renewal:"none" as const,olderMayBeOpen:false};}
/** Mirrors lib/billing.ts: the change was sent to Stripe and its outcome is not known. */
export class SwitchUnconfirmedError extends Error{constructor(cause:unknown){super("TEST ONLY switch sent, outcome unknown",{cause});this.name="SwitchUnconfirmedError";}}
export async function readSubscription(subscription:string){world.provider.push(["read",subscription]);return {state:world.readState};}
export async function switchPlan(subscription:string,choice:{tier:string;cycle:string},grant:unknown){
 world.provider.push(["switch",subscription,choice,grant]);
 if(world.switchEnd==="unconfirmed")throw new SwitchUnconfirmedError(Error("TEST ONLY reply lost after Stripe applied the switch"));
 if(world.switchEnd==="refused")throw new BillingError(402,"card_declined","TEST ONLY Stripe refused the change");
 if(world.switchEnd==="before")throw Error("TEST ONLY subscription read failed before any change");
 if(world.switchEnd==="inactive")return {kind:"switched",state:{state:"inactive"}};
 return {kind:"switched",state:{state:"active",trialing:false,until:0,cancelsAtEnd:false,tier:choice.tier,cycle:choice.cycle,amountCents:0,shared:false,period:null}};
}
export async function setSubscription(ref:string,fields:Record<string,unknown>){
 world.writes.push([ref,fields]);
 if(world.write==="throw")throw Error("TEST ONLY store write unavailable");
 return world.write==="null"?null:{...world.store,subscriptionActive:fields.active};
}
export const PLANS_ON_SALE=true;
export async function reserveSwitchContractFunding(){return {id:"grant_WriteTest"};}
export async function dropPause(){}
export async function pauseView(){return {kind:"none"};}
export async function undoPause(){return "none";}
