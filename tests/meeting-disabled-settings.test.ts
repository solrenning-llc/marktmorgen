import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {MeetingConnections} from "@/components/meeting-connections";
import {meetSettingsView,meetView,usableProviders} from "@/lib/meet-connect";
import {redisPipeline} from "@/lib/redis";
import {store as redis} from "./redis-stub";
globalThis.fetch=(async()=>{throw Error("Unexpected external request in synthetic settings test");}) as typeof fetch;
test("retained disabled connections are visible only for settings and offer withdrawal without productive controls",async()=>{
 const names=["GOOGLE_OAUTH_CLIENT_ID","GOOGLE_OAUTH_CLIENT_SECRET","ZOOM_CLIENT_ID","ZOOM_CLIENT_SECRET","ZOOM_WEBHOOK_SECRET_TOKEN"];
 const before=names.map(name=>process.env[name]);
 const pipeline=redis.pipeline;
 try{
  for(const name of names)delete process.env[name];
  redis.clear();
  const statsId="disabled-meeting-settings";
  for(const provider of ["google","zoom"]){
   await redisPipeline([["SET","nl:meet:conn:"+statsId+":"+provider,JSON.stringify({
    provider,account:{id:"synthetic-account",email:provider+"@example.test",name:provider},refresh:"",access:"",
    connectedAt:1,expires:0,scope:"",by:"owner@example.test",owner:{email:"owner@example.test",handle:"owner"},broken:"",brokenAt:0,
   })]]);
  }
  const commands:(string|number)[][]=[];
  redis.pipeline=function(batch){commands.push(...batch);return pipeline.call(this,batch);};
  const view=await meetSettingsView(statsId,{email:"owner@example.test"});
  assert.deepEqual(commands.map(command=>command[0]),["GET","GET","LRANGE"],"same maximum three reads as two configured providers, no scan");
  assert.deepEqual(commands[2].slice(-2),[0,19],"bounded existing problems list");
  assert.deepEqual(view.providers,["google","zoom"]);
  assert.equal(view.connected.google?.account,"google@example.test");
  assert.equal(view.connected.zoom?.account,"zoom@example.test");
  assert.deepEqual((await meetView(statsId)).providers,[],"ordinary booking view stays closed");
  assert.deepEqual(await usableProviders(statsId),[],"retained tokens never enable disabled providers");
  const html=renderToStaticMarkup(createElement(MeetingConnections,{view,pin:"",disabledProviders:["google","zoom"]}));
  assert.equal((html.match(/>Disconnect<\/button>/g)||[]).length,2,"each retained account has a real enabled withdrawal button");
  assert.equal((html.match(/>Unavailable<\/span>/g)||[]).length,2);
  for(const text of ["google@example.test","zoom@example.test","Existing meetings stay with the provider.","aria-labelledby=\"meet-google-title\"","aria-labelledby=\"meet-zoom-title\""])assert.ok(html.includes(text),text);
  for(const text of ["<form","data-meet-test","Use a different account","Make a test meeting","Then choose it for a call"])assert.equal(html.includes(text),false,text);
  assert.deepEqual((await meetSettingsView("empty-store",{email:"owner@example.test"})).providers,[],"do not advertise unconfigured unconnected services");
  assert.deepEqual((await meetSettingsView(null,{email:"owner@example.test"})).providers,[]);
  process.env.GOOGLE_OAUTH_CLIENT_ID="synthetic-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET="synthetic-secret";
  const mixed=await meetSettingsView(statsId,{email:"owner@example.test"});
  assert.deepEqual(mixed.providers,["google","zoom"]);
  assert.deepEqual(await usableProviders(statsId),["google"],"configured positive control remains productive");
  const mixedHtml=renderToStaticMarkup(createElement(MeetingConnections,{view:mixed,pin:"",disabledProviders:["zoom"]}));
  assert.ok(mixedHtml.includes("/api/integrations/google/start"));
  assert.equal(mixedHtml.includes("/api/integrations/zoom/start"),false);
  assert.ok(mixedHtml.includes('data-meet-test="google"'));
  assert.equal(mixedHtml.includes('data-meet-test="zoom"'),false);
 }finally{
  redis.pipeline=pipeline;
  names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});
 }
});
