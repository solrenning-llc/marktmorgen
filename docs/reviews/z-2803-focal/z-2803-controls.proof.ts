import test from "node:test";
import assert from "node:assert/strict";
import { COST_LINES } from "@/tests/plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { readFileSync } from "node:fs";
const line=COST_LINES.find(x=>x.id==="picture-uploads")!;
// Reference decomposition fixed from the declared worst request, independent of registry formula/constants.
const terms={put:11*5/1e6,sign:11*5/1e6,heads:33*0.4/1e6,reads:2*0.4/1e6,cdn:2*2/1e6,bytes:2*1_000_000*(0.1+0.06)/1e9};
const per=Object.values(terms).reduce((a,b)=>a+b,0);
for(const [tier,studio,expected] of [["creator",2000,0.896],["pro",5000,2.24],["scale",15000,6.72]] as const)test(tier+" includes full retry signing plus origin/CDN overhead",()=>{
 assert.equal(STORE_ALLOWANCES[tier].studio,studio);assert.ok(Math.abs(line.monthlyUsd(tier)-expected)<1e-10);assert.ok(Math.abs(line.monthlyUsd(tier)/studio-per)<1e-12);
});
test("the signing call and whole-read assumption remain auditable",()=>{
 assert.ok(line.sources.some(x=>x.names.includes("issueSignedToken")));
 const source=readFileSync('lib/uploaded-image.ts','utf8');assert.ok(source.includes('access: "private"'));assert.ok(source.includes('reader.cancel()'));
 assert.ok(line.basis.includes('Fast Origin Transfer'));assert.ok(line.basis.includes('CDN request'));
});
test("source checking keeps exact text while the two joined fixes keep the same amount",()=>{
 const source=readFileSync('tests/picture-upload-costs.test.ts','utf8');assert.ok(source.includes('.includes("Prices: vercel.com/docs/vercel-blob/usage-and-pricing, read on 6 November 2026")'));
 assert.ok(Math.abs(per-0.000448)<1e-12);assert.ok(Math.abs((terms.sign+2*1_000_000*0.06/1e9+terms.cdn)*2000-0.358)<1e-12);
});
