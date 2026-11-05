import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beginDiscordSignIn, finishDiscordSignIn, discordSignInOffered, DISCORD_SIGNIN_SCOPES, DISCORD_SIGNIN_APPROVED } from "@/lib/discord-signin";
import { store } from "./redis-stub";

process.env.DISCORD_SIGNIN_CLIENT_ID = "fixture-client";
process.env.DISCORD_SIGNIN_CLIENT_SECRET = "fixture-secret";
const calls: {url:string;init?:RequestInit}[]=[];
const email=["maker","example.test"].join("@");
let profile: unknown={id:"123456789012345678",email,verified:true};
let token: unknown={access_token:"fixture-access",token_type:"Bearer",scope:"identify email",expires_in:600};
let http=200;
globalThis.fetch=(async (url: string|URL|Request,init?:RequestInit)=>{
 calls.push({url:String(url),init});
 if(String(url)==="https://discord.com/api/oauth2/token")return Response.json(token,{status:http});
 if(String(url)==="https://discord.com/api/v10/users/@me")return Response.json(profile,{status:http});
 throw new Error("Unexpected network destination in synthetic test");
}) as typeof fetch;
const start=async()=>{const b=await beginDiscordSignIn("my-store");assert.ok(b,"an admitted synthetic flow starts");return{...b,url:new URL(b.url),state:new URL(b.url).searchParams.get("state")!,browserState:b.cookie.split(";")[0].split("=")[1]};};
const finish=(b:Awaited<ReturnType<typeof start>>)=>finishDiscordSignIn(b.state,b.browserState,"fixture-code","https://discord.com",false);

test("default approval and unknown costs make every entry unavailable without IO",async()=>{
 delete process.env.TEST_DISCORD_SIGNIN;
 assert.equal(DISCORD_SIGNIN_APPROVED,false);
 assert.equal(discordSignInOffered(),false);
 const old=calls.length;
 assert.equal(await beginDiscordSignIn(),null);
 assert.deepEqual(await finishDiscordSignIn("dsi."+"a".repeat(43),"dsi."+"a".repeat(43),"fixture-code","https://discord.com",false),{ok:false,reason:"expired"});
 assert.equal(calls.length,old);
 const policy=readFileSync("lib/discord-signin-policy.ts","utf8");
 assert.match(policy,/DISCORD_SIGNIN_APPROVED: boolean = false/);
 assert.match(policy,/CURRENT_DISCORD_SIGNIN_COST_REVIEW: null = null/);
 process.env.TEST_DISCORD_SIGNIN="1";
});
test("minimal scopes, S256, bound state, fixed redirect and finite cookie",async()=>{
 assert.deepEqual(DISCORD_SIGNIN_SCOPES,["identify","email"]);
 const b=await start();
 assert.equal(b.url.searchParams.get("scope"),"identify email");
 assert.equal(b.url.searchParams.get("response_type"),"code");
 assert.equal(b.url.searchParams.get("code_challenge_method"),"S256");
 assert.match(b.state,/^dsi\.[A-Za-z0-9_-]{43}$/);
 assert.equal(b.url.searchParams.get("redirect_uri"),"https://marktmorgen.com/api/integrations/discord/signin");
 assert.match(b.cookie,/HttpOnly/);assert.match(b.cookie,/Max-Age=600/);assert.match(b.cookie,/SameSite=Lax/);
 assert.equal(b.cookie.includes("my-store"),false,"context stays in server state");
 assert.deepEqual(await finish(b),{ok:true,email,handle:"my-store"});
 const body=new URLSearchParams(String(calls.at(-2)?.init?.body));
 assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),b.url.searchParams.get("code_challenge"));
 assert.equal(body.get("grant_type"),"authorization_code");
 assert.deepEqual(await finish(b),{ok:false,reason:"expired"});
});
test("wrong browser and issuer cannot exchange code or consume valid browser state",async()=>{
 const b=await start(),n=calls.length;
 assert.equal((await finishDiscordSignIn(b.state,"dsi."+"b".repeat(43),"fixture-code","https://discord.com",false)).ok,false);
 assert.equal((await finishDiscordSignIn(b.state,b.browserState,"fixture-code","https://other.example.test",false)).ok,false);
 assert.equal(calls.length,n);
 assert.equal((await finish(b)).ok,true);
});
test("a simultaneous replay reaches Discord only once",async()=>{
 const b=await start(),n=calls.length;
 const r=await Promise.all([finish(b),finish(b)]);
 assert.equal(r.filter(x=>x.ok).length,1);assert.equal(calls.length-n,2);
});
test("only exact verified true and a complete user response prove an address",async()=>{
 for(const bad of [undefined,null,false,"true",1]){
  profile={id:"123456789012345678",email,verified:bad};const b=await start();assert.equal((await finish(b)).ok,false);
 }
 for(const bad of [{},{id:"123456789012345678",verified:true},{id:"123456789012345678",email:null,verified:true},{id:"bad",email,verified:true},{id:"123456789012345678",email:"bad",verified:true}]){
  profile=bad;const b=await start();assert.equal((await finish(b)).ok,false);
 }
 profile={id:"123456789012345678",email,verified:true};
 assert.equal((await finish(await start())).ok,true);
});
test("unknown token envelope, wrong scopes, expiry and HTTP failures never read profile",async()=>{
 const valid=token;
 for(const bad of [null,{},[],{access_token:"fixture",token_type:"bearer",scope:"identify email",expires_in:600},{access_token:"fixture",token_type:"Bearer",scope:"identify email guilds",expires_in:600},{access_token:"fixture",token_type:"Bearer",scope:"identify",expires_in:600},{access_token:"fixture",token_type:"Bearer",scope:"identify email",expires_in:0}]){
  token=bad;const b=await start(),n=calls.length;assert.equal((await finish(b)).ok,false);assert.equal(calls.length-n,1);
 }
 token=valid;http=429;const b=await start(),n=calls.length;assert.equal((await finish(b)).ok,false);assert.equal(calls.length-n,1);http=200;
});
test("decline consumes state without provider calls",async()=>{
 const b=await start(),n=calls.length;assert.equal((await finishDiscordSignIn(b.state,b.browserState,"","https://discord.com",true)).ok,false);assert.equal(calls.length,n);assert.equal((await finish(b)).ok,false);
});
test("state expiry and lost Redis acknowledgement fail closed without fallback",async()=>{
 const b=await start();store.advance(601000);assert.equal((await finish(b)).ok,false);
 const real=store.pipeline.bind(store);let commands:string[]=[];
 store.pipeline=async cs=>{commands.push(...cs.map(c=>String(c[0])));return[];};
 try {assert.equal(await beginDiscordSignIn(),null);assert.deepEqual(commands,["SET"]);}finally{store.pipeline=real;}
 const b2=await start();commands=[];store.pipeline=async cs=>{commands.push(...cs.map(c=>String(c[0])));throw new Error("lost");};
 try{assert.equal((await finish(b2)).ok,false);assert.deepEqual(commands,["GETDEL"]);}finally{store.pipeline=real;}
});
test("no Discord identity or tokens remain after a completed login",async()=>{
 const b=await start();assert.equal((await finish(b)).ok,true);
 const keys=(store.run(["SCAN","0","MATCH","nl:auth:link:*","COUNT","1000"]) as [string,string[]])[1];
 for(const key of keys){const value=String(store.run(["GET",key]));assert.equal(value.includes(email),false);assert.equal(value.includes("fixture-access"),false);assert.equal(value.includes("123456789012345678"),false);}
});
