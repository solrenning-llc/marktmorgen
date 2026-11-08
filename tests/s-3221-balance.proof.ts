/** Codex S second financial review: exact balance reader delta. Synthetic provider only. */
import { claimHandle, setSubscription } from "@/lib/store";
import { creditOnPlan } from "@/lib/creator-invite-credit";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
let reply:unknown={balance:-1450,currency:"usd"};
globalThis.fetch=(async()=>new Response(JSON.stringify(reply),{status:200})) as typeof fetch;
async function main(){
 process.env.STRIPE_SECRET_KEY="sk_test_s3221_balance_stand_in_only";
 redis.clear();const made=await claimHandle("s-balance@example.com","s-balance","Balance","");if(!made.ok)throw Error("fixture");
 const store=await setSubscription("s-balance@example.com",{customerId:"cus_SBalance01",subscriptionId:"sub_SBalance01",active:true});if(!store)throw Error("subscription fixture");
 for(const [label,value,expected] of [
  ["healthy credit",{balance:-1450,currency:"usd"},{cents:1450,currency:"usd"}],
  ["debit is no credit",{balance:1450,currency:"usd"},{cents:0,currency:"usd"}],
  ["text balance unknown",{balance:"-1450",currency:"usd"},null],
  ["fraction balance unknown",{balance:-1450.5,currency:"usd"},null],
  ["numeric currency unknown",{balance:-1450,currency:978},null],
  ["missing balance unknown",{currency:"usd"},null],
 ] as const){reply=value;is(label,await creditOnPlan(store),expected);}
 done();
}
void main();
