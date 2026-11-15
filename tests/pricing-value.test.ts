import assert from "node:assert/strict";
import test from "node:test";
import { PRICING_VALUE } from "@/lib/pricing-value";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { COMPETITOR_PRICES } from "@/lib/competitor-prices";
test("pricing benefits resolve to existing capabilities before plan choices",()=>{
 assert.deepEqual(PRICING_VALUE.map(item=>item.name),["Checkout","Upsells","Affiliates","Funnels","Email automation","Community","Courses","Video calls","Analytics","CRM"]);
 for(const item of PRICING_VALUE){const slug=item.href.split("/").at(-1);assert.ok(FEATURE_PAGES.some(page=>page.section==="platform"&&page.slug===slug),item.href);assert.ok(item.benefit.length>40);}
});
test("Hotmart comparison reuses the existing dated official fee scope rather than a second fee model",()=>{
 const hotmart=COMPETITOR_PRICES.hotmart;
 assert.equal(hotmart.plans[0].source.readOn,"2026-11-15");
 assert.equal(new URL(hotmart.plans[0].source.url).hostname,"hotmart.com");
 assert.equal(hotmart.plans[0].feeSource.url,"https://hotmart.com/en/legal/payments-policy");
 assert.match(hotmart.feeScope,/above \$15/);
 assert.match(hotmart.policyScope,/September 21, 2026/);
});
