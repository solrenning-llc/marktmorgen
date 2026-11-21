import test from "node:test";
import assert from "node:assert/strict";
import { filterFormResponses, NO_CURRENT_FORM_RESULT } from "@/lib/form-response-filter";
import { responsesCsv } from "@/lib/forms";
import { form, responses } from "./form-response-fixture";
test("empty filters preserve response order and stable CRM identities",()=>{
  const selected=filterFormResponses(form,responses,"","");
  assert.deepEqual(selected,responses);assert.equal(selected[0],responses[0]);
  assert.equal(selected[0].opportunityRef,"a".repeat(64));
});
test("search ignores case and accents without changing original answers",()=>{
  assert.deepEqual(filterFormResponses(form,responses," JOSE ","").map(r=>r.id),[responses[0].id]);
  assert.equal(responses[0].answers.name00,"José");
});
test("email search is case insensitive",()=>{
  assert.equal(filterFormResponses(form,responses,"jose@EXAMPLE.com","")[0],responses[0]);
});
test("choice labels are searchable instead of internal option IDs",()=>{
  assert.equal(filterFormResponses(form,responses,"Coaching","")[0],responses[0]);
  assert.equal(filterFormResponses(form,responses,"coach0","").length,0);
});
test("quiz result titles are included in search",()=>{
  assert.equal(filterFormResponses(form,responses,"PRONTO","")[0],responses[0]);
});
test("search and quiz result selection are applied together",()=>{
  assert.deepEqual(filterFormResponses(form,responses,"example.com","later0"),[responses[1]]);
  assert.deepEqual(filterFormResponses(form,responses,"José","later0"),[]);
});
test("no current result includes empty and removed result identities",()=>{
  assert.deepEqual(filterFormResponses(form,responses,"",NO_CURRENT_FORM_RESULT),responses.slice(2));
});
test("obsolete selected result falls back to all current responses",()=>{
  assert.deepEqual(filterFormResponses(form,responses,"","unavailable"),responses);
});
test("CSV contains only selected responses and preserves existing consent wording",()=>{
  const selected=filterFormResponses({...form,offerList:true},responses,"ana","");
  const csv=responsesCsv({...form,offerList:true},selected);
  assert.match(csv,/Ana/);assert.doesNotMatch(csv,/José|Lee|Sam/);
  assert.match(csv,/Asked to hear from you/);assert.match(csv,/,"No"\r\n/);
});
test("filtered exports keep spreadsheet formula protection",()=>{
  const row={...responses[0],answers:{...responses[0].answers,name00:'=HYPERLINK("https://example.com")'}};
  const selected=filterFormResponses(form,[row],"HYPERLINK","");
  assert.ok(responsesCsv(form,selected).includes("'=HYPERLINK"));
});
test("search treats markup as plain words",()=>{
  const row={...responses[0],answers:{...responses[0].answers,name00:"<script>name</script>"}};
  assert.deepEqual(filterFormResponses(form,[row],"<script>",""),[row]);
});
test("filters cannot include responses that were not loaded",()=>{
  const loaded=responses.slice(0,1);assert.equal(filterFormResponses(form,loaded,"Ana","").length,0);
});

test("opportunity link filtering composes with text and quiz filters",()=>{
  const refs=new Set([responses[0].opportunityRef]);
  assert.deepEqual(filterFormResponses(form,responses,"example.com","ready0",{available:true,filter:"linked",refs}),[responses[0]]);
  assert.deepEqual(filterFormResponses(form,responses,"","",{available:true,filter:"unlinked",refs}),responses.slice(1));
});
test("an unavailable CRM read pauses opportunity filtering without fabricating unlinked answers",()=>{
  assert.deepEqual(filterFormResponses(form,responses,"","",{available:false,filter:"unlinked",refs:new Set()}),responses);
  assert.deepEqual(filterFormResponses(form,responses,"","",{available:false,filter:"linked",refs:new Set()}),responses);
});
test("opportunity filtering retains the stable response and source reference used by conversion",()=>{
  const selected=filterFormResponses(form,responses,"","",{available:true,filter:"linked",refs:new Set([responses[0].opportunityRef])});
  assert.equal(selected[0],responses[0]);assert.equal(selected[0].opportunityRef,responses[0].opportunityRef);
});
