import assert from "node:assert/strict";
import test from "node:test";
import {postBySlug} from "@/lib/blog";

test("the file guide's final checklist keeps the same test-only rehearsal as its note",()=>{
  const post=postBySlug("sell-a-digital-file-from-your-bio");
  assert.ok(post);
  const steps=post.body.flatMap(block=>block.type==="steps"?block.items:[]);
  const friday=steps.find(step=>step.title==="Friday");
  assert.ok(friday,"the practical Friday checklist remains present");
  assert.doesNotMatch(friday.text,/\bbuy it yourself\b/i,"the final instruction must not return to an unqualified self-purchase");
  assert.match(friday.text,/test mode|test card|test purchase|test checkout/i,"the final rehearsal must explicitly stay in test mode");
});
