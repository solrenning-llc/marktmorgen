import { test } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "@/lib/store";
import type { StripePurchaseBinding } from "@/lib/dispute-purchase-binding";
import { readRetainedPreorderReview, PREORDER_REVIEW_READ } from "@/lib/dispute-preorder-review";
import { state, reset } from "./dispute-preorder-world";
const store = { sid: "storefixture", statsId: "statsfixture", stripeAccountId: "acct_fixture", tier: "creator" } as Store;
const binding = { account: "acct_fixture", purchase: "cs_fixture", product: "a".repeat(32), paymentIntent: "pi_fixture", buyerEmail: "buyer@example.test", checkoutCreatedAt: 100, chargeCreatedAt: 110 } as StripePurchaseBinding;
const row = { to: binding.buyerEmail, pi: binding.paymentIntent, at: 100, given: 120 };
const at = 200_000;
test("one exact retained row requires funding and allowance before a bounded read", async () => {
 reset();state.reply=[1,JSON.stringify(row),60_000];
 assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"available",checkoutCreatedAt:100,grantedAt:120,revokedAt:null,lookupStartedAt:200,retainedUntil:260});
 assert.deepEqual(state.order,["funding","integration","read"]);
 assert.deepEqual(state.commands,[["EVAL",PREORDER_REVIEW_READ,1,"nl:pre:statsfixture:"+"a".repeat(32),"cs_fixture"]]);
 assert.match(PREORDER_REVIEW_READ,/string.len\(v\)>1024/);
 assert.equal(/redis.call\("(?:SET|EXPIRE|PEXPIRE|HSET|DEL)"/.test(PREORDER_REVIEW_READ),false);
});
test("different account and malformed key material cause no read or reservation", async () => {
 for(const changed of [{...store,stripeAccountId:"acct_other"},{...store,statsId:"other:key"},{...store,statsId:null}]){
  reset();assert.deepEqual(await readRetainedPreorderReview(changed as Store,binding,at),{status:"unavailable"});assert.deepEqual(state.order,[]);
 }
});
test("unfunded, exhausted and unconfigured reads stay closed", async () => {
 reset();state.funded=false;await readRetainedPreorderReview(store,binding,at);assert.deepEqual(state.order,["funding"]);
 reset();state.allowance=false;await readRetainedPreorderReview(store,binding,at);assert.deepEqual(state.order,["funding","integration"]);
 reset();state.configured=false;await readRetainedPreorderReview(store,binding,at);assert.deepEqual(state.order,[]);
});
test("buyer, payment and checkout timestamp must match without returning foreign data", async () => {
 for(const other of [{...row,to:"other@example.test"},{...row,pi:"pi_other"},{...row,at:101}]){
  reset();state.reply=[1,JSON.stringify(other),60_000];assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"unavailable"});
 }
});
test("expiration, absent expiry, oversize, malformed and future data refuse", async () => {
 for(const reply of [[1,JSON.stringify(row),0],[1,JSON.stringify(row),-1],[1,JSON.stringify(row),400*86_400_000+1],[2,"",60_000],[1,"x".repeat(1025),60_000],[1,"{",60_000],[1,JSON.stringify({...row,given:201}),60_000],[1,JSON.stringify({...row,revoked:99}),60_000]]){
  reset();state.reply=reply;assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"unavailable"});
 }
});
test("missing record differs from unavailable and never implies no purchase", async () => {
 reset();state.reply=[0,"",-2];assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"missing"});
 reset();state.error=true;assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"unavailable"});
});
test("grant and refund are separate recorded states, with no invented grant date", async () => {
 reset();state.reply=[1,JSON.stringify({...row,given:undefined,revoked:150}),60_000];
 assert.deepEqual(await readRetainedPreorderReview(store,binding,at),{status:"available",checkoutCreatedAt:100,grantedAt:null,revokedAt:150,lookupStartedAt:200,retainedUntil:260});
});

// #4713: the retained pre-order read accepts the same Checkout Session IDs as the dispute binding.
for (const id of ["cs_fixture", "cs_test_SyntheticFixture123", "cs_live_SyntheticFixture123"]) {
  test("retained pre-order read with checkout session id " + id, async () => {
    const bound = { ...binding, purchase: id } as StripePurchaseBinding;
    reset(); state.reply = [1, JSON.stringify({ to: bound.buyerEmail, pi: bound.paymentIntent, at: 100, given: 120 }), 60_000];
    assert.equal((await readRetainedPreorderReview(store, bound, at)).status, "available");
  });
}
