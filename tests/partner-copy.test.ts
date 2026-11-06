import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {STUDIO_MESSAGES} from "@/lib/studio-messages";
import PageError from "@/app/error";
test("shared studio microcopy preserves every persisted refusal code and gives a next step",()=>{
 assert.deepEqual(Object.keys(STUDIO_MESSAGES).sort(),["files_unavailable","locked","plan_disputed","renewal_unpaid","role","slow_down","storage_full","storage_setup","storage_trial","store_full","store_gone","upload_budget_unavailable","upload_refresh","upload_stopped","uploads_pending"]);
 for(const key of ["role","locked","store_gone","storage_full","storage_trial","upload_refresh","store_full","uploads_pending","upload_stopped","slow_down","files_unavailable","renewal_unpaid","plan_disputed"]){
  const text=STUDIO_MESSAGES[key];assert.match(text,/ask|check|reload|review|choose|try|finish|cancel|keep/i,key);
  assert.doesNotMatch(text,/successfully saved|has been saved|guaranteed|the page will be back shortly|that is a lot/i,key);
 }
 assert.match(STUDIO_MESSAGES.store_full,/record space/i);
 assert.doesNotMatch(STUDIO_MESSAGES.store_full,/move to a larger plan/i);
 assert.match(STUDIO_MESSAGES.storage_full,/remaining storage/i);
});
test("global render failure offers retry and reference without restoration-time promises",()=>{
 const html=renderToStaticMarkup(createElement(PageError,{error:Object.assign(new Error("synthetic"),{digest:"synthetic-ref"}),reset:()=>{}}));
 assert.match(html,/Try again/);assert.match(html,/Reference: synthetic-ref/);assert.match(html,/href="\//);
 assert.doesNotMatch(html,/back shortly|usually works|guaranteed/i);
});
