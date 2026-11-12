import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_PAGES, CREATOR_PAGES } from "@/lib/feature-pages";
import { FEATURE_MECHANISMS } from "@/lib/feature-mechanisms";
import { findPage } from "@/lib/site-pages";
test("every feature and creator page has one factual mechanism, with no orphan or missing entry",()=>{
 const pages=[...FEATURE_PAGES,...CREATOR_PAGES];
 assert.equal(pages.length,44);
 assert.deepEqual(pages.map(page=>page.slug).sort(),Object.keys(FEATURE_MECHANISMS).sort());
 for(const page of pages){
  const blocks=page.blocks.filter(block=>block.kind==="how"&&block.title==="A practical way to use it");
  assert.equal(blocks.length,1,page.slug);
  const block=blocks[0];assert.ok(block.kind==="how");assert.deepEqual(block.items,[FEATURE_MECHANISMS[page.slug]]);
  assert.ok(findPage(page.section,page.slug));
 }
});
test("mechanisms describe existing choices, consent and records without numeric outcome claims",()=>{
 for(const [slug,mechanism] of Object.entries(FEATURE_MECHANISMS)){
  assert.ok(mechanism.title.length>8,slug);assert.ok(mechanism.body.length>90,slug);
  assert.doesNotMatch(mechanism.body,/[0-9%]|guaranteed (?:sales|revenue|profit)|scale your business|double your/i,slug);
 }
 assert.match(FEATURE_MECHANISMS.email.body,/permission/);
 assert.match(FEATURE_MECHANISMS.crm.body,/consent/);
 assert.match(FEATURE_MECHANISMS["email-platforms"].body,/purchase alone is not permission/);
 assert.match(FEATURE_MECHANISMS.insights.body,/Missing attribution stays missing/);
 assert.match(FEATURE_MECHANISMS["your-stripe"].body,/tax or platform obligations/);
});
