import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { appleClientSecret, appleSignInOffered, beginAppleSignIn, finishAppleSignIn, APPLE_SIGNIN_APPROVED } from "@/lib/apple-signin";
import { store } from "./redis-stub";
import { NextRequest } from "next/server";
import { POST as startRoute } from "@/app/api/auth/apple/route";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppleSignIn } from "@/components/apple-signin";
const client="com.example.fixture.signin";
const ec=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const rsa=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...rsa.publicKey.export({format:"jwk"}),kid:"fixture-key",alg:"RS256",use:"sig"};
process.env.APPLE_SIGNIN_CLIENT_ID=client;
process.env.APPLE_SIGNIN_TEAM_ID="FIXTURE123";
process.env.APPLE_SIGNIN_KEY_ID="FIXTURE456";
process.env.APPLE_SIGNIN_PRIVATE_KEY=ec.privateKey.export({type:"pkcs8",format:"pem"}).toString();
const email=["maker","example.test"].join("@");
let override:Record<string,unknown>={};let header:Record<string,unknown>={};let wrongKey=false;let keys:unknown={keys:[jwk]};let responseStatus=200;
const calls:{url:string;init?:RequestInit}[]=[];
let nonce="";
const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString("base64url");
function idToken(){const body={iss:"https://appleid.apple.com",aud:client,sub:"fixture-subject",nonce,email,email_verified:true,is_private_email:false,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...override};const input=encode({alg:"RS256",kid:"fixture-key",...header})+"."+encode(body);return input+"."+(wrongKey?Buffer.from("bad"):sign("RSA-SHA256",Buffer.from(input),rsa.privateKey)).toString("base64url");}
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 calls.push({url:String(input),init});
 if(String(input)==="https://appleid.apple.com/auth/token")return Response.json({id_token:idToken(),access_token:"fixture-access",refresh_token:"fixture-refresh",token_type:"Bearer",expires_in:600},{status:responseStatus});
 if(String(input)==="https://appleid.apple.com/auth/keys")return Response.json(keys,{status:responseStatus});
 throw new Error("Unexpected destination in synthetic Apple test");
}) as typeof fetch;
async function start(){const b=await beginAppleSignIn("my-store");assert.ok(b,"admitted synthetic Apple flow starts");const url=new URL(b.url);nonce=url.searchParams.get("nonce")!;return{...b,url,state:url.searchParams.get("state")!,browserState:b.cookie.split(";")[0].split("=")[1]};}
const finish=(b:Awaited<ReturnType<typeof start>>)=>finishAppleSignIn(b.state,b.browserState,"fixture-code",false);

test("approval false and unknown cost keep Apple absent without IO",async()=>{
 delete process.env.TEST_APPLE_SIGNIN;assert.equal(APPLE_SIGNIN_APPROVED,false);assert.equal(appleSignInOffered(),false);assert.equal(await beginAppleSignIn(),null);assert.equal(calls.length,0);
 const policy=readFileSync("lib/apple-signin-policy.ts","utf8");assert.match(policy,/APPLE_SIGNIN_APPROVED: boolean = false/);assert.match(policy,/CURRENT_APPLE_SIGNIN_COST_REVIEW: null = null/);
 process.env.TEST_APPLE_SIGNIN="1";
});
test("client secret is a five-minute ES256 JWT with raw 64-byte signature",()=>{
 const jwt=appleClientSecret();assert.ok(jwt);const [h,b,s]=jwt.split(".");assert.deepEqual(JSON.parse(Buffer.from(h,"base64url").toString()),{alg:"ES256",kid:"FIXTURE456",typ:"JWT"});const body=JSON.parse(Buffer.from(b,"base64url").toString());assert.equal(body.iss,"FIXTURE123");assert.equal(body.sub,client);assert.equal(body.aud,"https://appleid.apple.com");assert.equal(body.exp-body.iat,300);assert.equal(Buffer.from(s,"base64url").length,64);assert.equal(verify("sha256",Buffer.from(h+"."+b),{key:ec.publicKey,dsaEncoding:"ieee-p1363"},Buffer.from(s,"base64url")),true);
});
test("email-only code flow uses nonce, form_post and Secure None browser cookie",async()=>{
 const b=await start();assert.equal(b.url.origin,"https://appleid.apple.com");assert.equal(b.url.searchParams.get("scope"),"email");assert.equal(b.url.searchParams.get("response_type"),"code");assert.equal(b.url.searchParams.get("response_mode"),"form_post");assert.equal(b.url.searchParams.get("redirect_uri"),"https://marktmorgen.com/api/integrations/apple/signin");assert.match(b.state,/^asi\.[A-Za-z0-9_-]{43}$/);assert.match(nonce,/^[A-Za-z0-9_-]{43}$/);assert.match(b.cookie,/HttpOnly/);assert.match(b.cookie,/SameSite=None; Secure/);
 assert.deepEqual(await finish(b),{ok:true,email,handle:"my-store",privateRelay:false});assert.deepEqual(await finish(b),{ok:false,reason:"expired"});
 const form=new URLSearchParams(String(calls.at(-2)?.init?.body));assert.equal(form.get("grant_type"),"authorization_code");assert.ok(form.get("client_secret"));assert.equal(form.get("code"),"fixture-code");
});
test("wrong browser and parallel replay cannot exchange twice",async()=>{
 const b=await start(),n=calls.length;assert.equal((await finishAppleSignIn(b.state,"asi."+"x".repeat(43),"fixture-code",false)).ok,false);assert.equal(calls.length,n);
 const results=await Promise.all([finish(b),finish(b)]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(calls.length-n,2);
});
test("signed wrong issuer, audience, nonce, expired/future dates and missing identity all fail",async()=>{
 for(const bad of [{iss:"https://other.example.test"},{aud:"other"},{nonce:"wrong"},{exp:0},{exp:"9999999999"},{iat:Math.floor(Date.now()/1000)+300},{sub:""},{email:null},{email:"invalid"},{email_verified:undefined},{email_verified:false},{email_verified:"false"},{email_verified:1}]){override=bad;assert.equal((await finish(await start())).ok,false,JSON.stringify(bad));}
 override={email_verified:"true"};assert.equal((await finish(await start())).ok,true);override={};
});
test("tampered signatures, algorithm confusion and missing/ambiguous signing keys fail",async()=>{
 wrongKey=true;assert.equal((await finish(await start())).ok,false);wrongKey=false;
 for(const bad of [{alg:"none"},{alg:"HS256"},{kid:"other"},{crit:["unknown"]}]){header=bad;assert.equal((await finish(await start())).ok,false);}header={};
 for(const bad of [{},{keys:[]},{keys:[jwk,jwk]},{keys:[{...jwk,alg:"HS256"}]},{keys:[{...jwk,kty:"EC"}]}]){keys=bad;assert.equal((await finish(await start())).ok,false);}keys={keys:[jwk]};
});
test("both private relay domains remain their own address with explicit relay status",async()=>{
 for(const domain of ["privaterelay.appleid.com","private.icloud.com"]){const relay=["fixture",domain].join("@");override={email:relay,is_private_email:"true"};assert.deepEqual(await finish(await start()),{ok:true,email:relay,handle:"my-store",privateRelay:true});}
 override={};assert.deepEqual(await finish(await start()),{ok:true,email,handle:"my-store",privateRelay:false});
});
test("decline, expired state, unavailable keys and invalid client key cannot prove identity",async()=>{
 const b=await start(),n=calls.length;assert.equal((await finishAppleSignIn(b.state,b.browserState,"",true)).ok,false);assert.equal(calls.length,n);assert.equal((await finish(b)).ok,false);
 const exp=await start();store.advance(601000);assert.equal((await finish(exp)).ok,false);
 responseStatus=503;assert.equal((await finish(await start())).ok,false);responseStatus=200;
 const saved=process.env.APPLE_SIGNIN_PRIVATE_KEY;process.env.APPLE_SIGNIN_PRIVATE_KEY="invalid";assert.equal(appleClientSecret(),null);process.env.APPLE_SIGNIN_PRIVATE_KEY=saved;
});
test("no provider token, subject or profile is written to Redis",async()=>{
 const real=store.pipeline.bind(store);const values:string[]=[];store.pipeline=async cs=>{for(const c of cs)if(c[0]==="SET")values.push(String(c[2]));return real(cs);};
 try{assert.equal((await finish(await start())).ok,true);}finally{store.pipeline=real;}
 assert.equal(values.length,1);for(const value of values){assert.equal(value.includes(email),false);assert.equal(value.includes("fixture-refresh"),false);assert.equal(value.includes("fixture-subject"),false);}
});

test("native form explains the separate relay account and retains the emailed-link alternative",()=>{
 const html=renderToStaticMarkup(createElement(AppleSignIn,{handle:"my-store"}));
 assert.match(html,/Continue with Apple/);assert.match(html,/different account/);assert.match(html,/use its emailed link/);assert.match(html,/<form[^>]*action="\/api\/auth\/apple"[^>]*method="post"/);
});
test("start route is absent while off; start limit and unknown counter refuse before state",async()=>{
 const req=()=>new NextRequest("https://marktmorgen.com/api/auth/apple",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-forwarded-for":"203.0.113.101"},body:"handle=my-store"});
 delete process.env.TEST_APPLE_SIGNIN;
 const real=store.pipeline.bind(store);let commands=0;
 store.pipeline=async cs=>{commands+=cs.length;return real(cs);};
 try{assert.equal((await startRoute(req())).status,404);assert.equal(commands,0);}finally{store.pipeline=real;}
 process.env.TEST_APPLE_SIGNIN="1";
 assert.equal((await startRoute(new NextRequest("https://marktmorgen.com/api/auth/apple",{method:"POST",headers:{origin:"https://other.example.test",host:"marktmorgen.com"}}))).status,403);
 for(let i=0;i<20;i++)assert.ok((await startRoute(req())).headers.get("location")?.startsWith("https://appleid.apple.com/auth/authorize?"));
 assert.match((await startRoute(req())).headers.get("location")!,/apple-slow/);
 commands=0;store.pipeline=async cs=>{commands+=cs.length;return[null,null];};
 // An unreadable counter is not "too many tries" (Claude 5 / Claude 1 LOW): it is said as an error.
 try{assert.match((await startRoute(req())).headers.get("location")!,/apple-error/);assert.equal(commands,2);}finally{store.pipeline=real;}
});

test("the relay notice comes before the button and describes it (Claude 5 / Claude 1 LOW)",()=>{
 const html=renderToStaticMarkup(createElement(AppleSignIn,{handle:"my-store"}));
 const notice=html.indexOf("different account"),button=html.indexOf("Continue with Apple");
 assert.ok(notice>=0&&button>notice,"read before reaching the button, by keyboard or screen reader");
 const id=/<p[^>]*id="([^"]+)"[^>]*>[^<]*different account/.exec(html)?.[1];
 assert.ok(id,"the notice has an id");
 assert.match(html,new RegExp(`<button[^>]*aria-describedby="${id}"[^>]*>Continue with Apple`));
});
test("the cross-site binding cookie carries the __Secure- prefix (Claude 5 / Claude 1 LOW)",async()=>{
 process.env.TEST_APPLE_SIGNIN="1";
 const b=await beginAppleSignIn("my-store");
 assert.ok(b);
 assert.match(b.cookie,/^__Secure-[^=]+=asi\./);
 assert.match(b.cookie,/; Secure/);
});
