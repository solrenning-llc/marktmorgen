import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {buyerSignInTarget,buyerSignInReturnPath,buyerSignInOptions,BUYER_PROVIDERS} from "@/lib/buyer-provider-signin-rules";
import {BuyerProviderSignIn} from "@/components/buyer-provider-signin";
import {LANGUAGE_CODES} from "@/lib/store-language";
import {providerSignInWords} from "@/lib/buyer-words/provider-signin";

test("library and one validated store manage target have fixed local return paths",()=>{
 assert.deepEqual(buyerSignInTarget("library"),{kind:"library"});assert.equal(buyerSignInReturnPath({kind:"library"}),"/library");
 assert.deepEqual(buyerSignInTarget("manage:my-store"),{kind:"manage",handle:"my-store"});assert.equal(buyerSignInReturnPath({kind:"manage",handle:"my-store"}),"/@my-store/manage");
});
test("arbitrary return URLs and malformed handles never become a target",()=>{
 for(const raw of [undefined,null,{},[],"","/library","//evil.example.test","https://evil.example.test","library?next=evil","manage:","manage:../evil","manage:my-store/leave","manage:my%2fstore","manage:my-store#x","manage:MY-STORE","manage:__proto__","manage:ab","manage:"+"x".repeat(25)])assert.equal(buyerSignInTarget(raw),null,String(raw));
 assert.equal(buyerSignInReturnPath({kind:"manage",handle:"//evil"}),null);
});
test("no approved options means no social buttons or supplier request",()=>{
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"library"})),"");
 assert.deepEqual(buyerSignInOptions(undefined),[]);assert.deepEqual(buyerSignInOptions(null),[]);assert.deepEqual(buyerSignInOptions(["google","discord"]),["google","discord"]);
});
test("options require exact providers, deduplicate and keep Google Apple Discord order",()=>{
 assert.deepEqual(BUYER_PROVIDERS,["google","apple","discord"]);assert.deepEqual(buyerSignInOptions(["discord","apple","google","google"]),["google","apple","discord"]);
 assert.deepEqual(buyerSignInOptions(["Google",true,"__proto__","discord"]),[]);
});
test("native forms preserve the destination in each language without customer email or token",()=>{
 for(const language of LANGUAGE_CODES){const html=renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"manage:my-store",language,providers:BUYER_PROVIDERS}));
 assert.equal((html.match(/<form /g)??[]).length,3,language);assert.equal((html.match(/type="submit"/g)??[]).length,3,language);assert.equal((html.match(/name="target" value="manage:my-store"/g)??[]).length,3,language);
 for(const p of BUYER_PROVIDERS)assert.ok(html.includes('action="/api/buyer/auth/'+p+'"'));
 assert.equal(html.includes('name="email"'),false);assert.equal(html.includes('name="token"'),false);
 }
});
test("invalid targets render nothing even with explicit provider choices",()=>{
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"https://other.example.test",providers:BUYER_PROVIDERS})),"");
});

test("missing or accessor option evidence cannot publish a partial choice",()=>{
 const missing=new Array(2);missing[0]="google";assert.deepEqual(buyerSignInOptions(missing),[]);
 let reads=0;const accessor=["google"];Object.defineProperty(accessor,"0",{get(){reads++;return"google";}});assert.deepEqual(buyerSignInOptions(accessor),[]);assert.equal(reads,0);
});
test("all seven languages preserve purchase-address and relay guidance",()=>{
 for(const language of LANGUAGE_CODES){const w=providerSignInWords(language);assert.deepEqual(Object.keys(w).sort(),["apple","discord","google","purchase","relay"]);assert.ok(w.purchase.length>40);assert.ok(w.relay.length>80);for(const provider of BUYER_PROVIDERS)assert.ok(w[provider].includes(provider[0].toUpperCase()+provider.slice(1)));}
 assert.match(providerSignInWords("en").purchase,/same email address/);assert.match(providerSignInWords("en").relay,/different address/);assert.match(providerSignInWords("en").relay,/emailed link/);
});
