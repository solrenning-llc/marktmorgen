import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {buyerSignInTarget,buyerSignInReturnPath,buyerSignInOptions,BUYER_PROVIDERS} from "@/lib/buyer-provider-signin-rules";
import {BuyerProviderSignIn} from "@/components/buyer-provider-signin";
import {LANGUAGE_CODES} from "@/lib/store-language";
import {providerSignInWords} from "@/lib/buyer-words/provider-signin";
import {generateKeyPairSync} from "node:crypto";
import {GOOGLE_SIGNIN_TRY_QUERY} from "@/lib/google-signin";
import {SITE_URL} from "@/lib/site-url";

// The three providers switched on synthetically, as their own tests do (policy
// fixtures through tests/aliases/buyer-provider-signin.test.ts.json); Google only
// on the owner's try query, as before approval.
const HOST=new URL(SITE_URL).host;
function allOn(){
 process.env.TEST_APPLE_SIGNIN="1";process.env.APPLE_SIGNIN_CLIENT_ID="com.example.fixture.signin";process.env.APPLE_SIGNIN_TEAM_ID="FIXTURE123";process.env.APPLE_SIGNIN_KEY_ID="FIXTURE456";
 process.env.APPLE_SIGNIN_PRIVATE_KEY=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
 process.env.TEST_DISCORD_SIGNIN="1";process.env.DISCORD_SIGNIN_CLIENT_ID="fixture-client";process.env.DISCORD_SIGNIN_CLIENT_SECRET="fixture-secret";
 process.env.GOOGLE_SIGNIN_LIVE="1";process.env.GOOGLE_OAUTH_CLIENT_ID="fixture-google";process.env.GOOGLE_OAUTH_CLIENT_SECRET="fixture-google-secret";
}
function allOff(){for(const k of ["TEST_APPLE_SIGNIN","TEST_DISCORD_SIGNIN","GOOGLE_SIGNIN_LIVE"])delete process.env[k];}
const shown={host:HOST,tryQuery:GOOGLE_SIGNIN_TRY_QUERY};

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
 allOn();
 for(const language of LANGUAGE_CODES){const html=renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"manage:my-store",language,providers:BUYER_PROVIDERS,...shown}));
 assert.equal((html.match(/<form /g)??[]).length,3,language);assert.equal((html.match(/type="submit"/g)??[]).length,3,language);assert.equal((html.match(/name="target" value="manage:my-store"/g)??[]).length,3,language);
 for(const p of BUYER_PROVIDERS)assert.ok(html.includes('action="/api/buyer/auth/'+p+'"'));
 assert.equal(html.includes('name="email"'),false);assert.equal(html.includes('name="token"'),false);
 }
});
test("invalid targets render nothing even with explicit provider choices",()=>{
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"https://other.example.test",providers:BUYER_PROVIDERS,...shown})),"");
});

test("missing or accessor option evidence cannot publish a partial choice",()=>{
 const missing=new Array(2);missing[0]="google";assert.deepEqual(buyerSignInOptions(missing),[]);
 let reads=0;const accessor=["google"];Object.defineProperty(accessor,"0",{get(){reads++;return"google";}});assert.deepEqual(buyerSignInOptions(accessor),[]);assert.equal(reads,0);
});
test("all seven languages preserve purchase-address and relay guidance",()=>{
 for(const language of LANGUAGE_CODES){const w=providerSignInWords(language);assert.deepEqual(Object.keys(w).sort(),["apple","discord","google","purchase","relay"]);assert.ok(w.purchase.length>40);assert.ok(w.relay.length>80);for(const provider of BUYER_PROVIDERS)assert.ok(w[provider].includes(provider[0].toUpperCase()+provider.slice(1)));}
 assert.match(providerSignInWords("en").purchase,/same email address/);assert.match(providerSignInWords("en").relay,/different address/);assert.match(providerSignInWords("en").relay,/emailed link/);
});

test("the component fails closed by itself: off, or on a creator's own domain, it shows nothing (Claude 5 / Claude 1 MEDIUM)",()=>{
 allOff();
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"library",providers:BUYER_PROVIDERS,...shown})),"","every approval off");
 allOn();
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"manage:my-store",providers:BUYER_PROVIDERS,host:"shop.creator.example",tryQuery:GOOGLE_SIGNIN_TRY_QUERY})),"","a creator's domain: no state cookie could close there");
 assert.equal(renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"library",providers:BUYER_PROVIDERS})),"","no host is no host");
 const noTry=renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"library",providers:BUYER_PROVIDERS,host:HOST}));
 assert.equal(noTry.includes("/api/buyer/auth/google"),false,"Google before approval only on the owner's try link");
 assert.equal((noTry.match(/<form /g)??[]).length,2);
 allOff();
});
test("the notices come before the buttons and describe them (Claude 5 / Claude 1 MEDIUM)",()=>{
 allOn();
 const html=renderToStaticMarkup(createElement(BuyerProviderSignIn,{target:"library",providers:BUYER_PROVIDERS,...shown}));
 const first=html.indexOf("<button");
 const w=providerSignInWords("en");
 assert.ok(html.indexOf("same email address")<first&&html.indexOf("different address")<first,"both read before the first button");
 const ids=[...html.matchAll(/<p[^>]*id="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(ids.length,2);
 for(const p of BUYER_PROVIDERS){
  const described=new RegExp(`<button[^>]*aria-describedby="([^"]+)"[^>]*>${w[p]}<`).exec(html)?.[1]?.split(" ")??[];
  assert.ok(described.includes(ids[0]),`${p} is described by the purchase-address notice`);
  assert.equal(described.includes(ids[1]),p==="apple",`only Apple carries the relay notice`);
 }
 allOff();
});
