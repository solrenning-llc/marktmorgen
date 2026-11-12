/**
 * A short visit to a store is still a visit (components/store-beacon.tsx).
 *
 * The visit count goes through the host's browser check, whose challenge
 * script is fetched and run only when the first checked request is made
 * (botid/client/core: initBotId patches fetch, and getChallenge loads the
 * script on the first protected call). A count deferred to the buyer's first
 * pause (lib/quiet-moment.ts) is therefore made while the page is being left
 * when the buyer leaves before that pause, and a page that is going away
 * never finishes loading the challenge: the request never leaves.
 *
 * This lab opens the demo store on a phone four times slower than a laptop,
 * stays STAY ms after the load, then leaves it (by navigation, and by
 * closing the tab) and counts the visit requests that reached the server.
 * A control visit that stays past the pause must count too.
 *
 * Nothing real: a counting proxy in front of `next start` answers
 * POST /api/store/hit itself, and stands in for the host's challenge script
 * with one block of CHALLENGE_MS of work followed by a challenge, about what
 * the real one costs on this phone (tests/e2e/mobile-render.mjs, 11 Nov 2026).
 * The rest of the outside services are tests/e2e/services.mjs.
 *
 * Usage: node tests/e2e/store-short-visit.mjs <built app root>
 * (SHORT_VISIT_CHROME: a Chrome binary; otherwise the installed Chrome channel.)
 */
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {createServer,request as httpRequest} from "node:http";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";

const appRoot=resolve(process.argv[2]??".");
const require=createRequire(join(appRoot,"package.json"));
const {chromium}=require("playwright-core");
const NEXT=3187,PROXY=3188,SERVICES=4488,FAKE="http://127.0.0.1:"+SERVICES,LOCAL="http://127.0.0.1:"+PROXY;
const CHALLENGE_MS=225,SHORT_STAY_MS=500,LONG_STAY_MS=4000,SETTLE_MS=4000,RUNS=2;

const {startServices}=await import(pathToFileURL(join(appRoot,"tests/e2e/services.mjs")).href);
const services=await startServices(SERVICES);
const app=spawn(process.execPath,[join(appRoot,"node_modules/next/dist/bin/next"),"start","-p",String(NEXT)],{cwd:appRoot,env:{...process.env,
 DEMO_STUDIO_ADMIN:"operator@example.test",STRIPE_DEMO_ACCOUNT_ID:"acct_fixtureDemo",UPSTASH_REDIS_REST_URL:FAKE,UPSTASH_REDIS_REST_TOKEN:"local",
 STRIPE_SECRET_KEY:"sk_test_local_only_a_stand_in_0000",STRIPE_CONNECT_API_BASE:FAKE,VERCEL_BLOB_API_URL:FAKE+"/blob-api",
 BLOB_READ_WRITE_TOKEN:"vercel_blob_rw_localstore_standinsecret0000",NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
let output="";app.stdout.on("data",data=>{output=(output+data).slice(-4000);});app.stderr.on("data",data=>{output=(output+data).slice(-4000);});

const hits=[];
const proxy=createServer((request,response)=>{
 if(request.method==="POST"&&request.url.startsWith("/api/store/hit")){
  let body="";request.on("data",chunk=>{body+=chunk;});
  request.on("end",()=>{hits.push({checked:Boolean(request.headers["x-is-human"]),body});response.writeHead(204);response.end();});
  return;
 }
 if(request.url.includes("/a-4-a/c.js")){
  response.writeHead(200,{"content-type":"application/javascript","cache-control":"no-store"});
  response.end(`(()=>{const end=performance.now()+${CHALLENGE_MS};while(performance.now()<end){}(window.V_C=window.V_C||[]).push({b:1});})();`);
  return;
 }
 const upstream=httpRequest({host:"127.0.0.1",port:NEXT,method:request.method,path:request.url,headers:{...request.headers,host:"127.0.0.1:"+PROXY}},reply=>{response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);});
 upstream.on("error",()=>{response.writeHead(502);response.end();});request.pipe(upstream);
});
await new Promise(accept=>proxy.listen(PROXY,"127.0.0.1",accept));

let browser,failed=false;
try{
 let ready=false;for(let attempt=0;attempt<120;attempt++){if(app.exitCode!==null)throw Error("Application exited: "+output);try{if((await fetch(LOCAL)).ok){ready=true;break;}}catch{}await new Promise(accept=>setTimeout(accept,500));}
 if(!ready)throw Error("Application unavailable: "+output);
 const demo=await fetch(LOCAL+"/demo",{redirect:"follow"});const storePath=new URL(demo.url).pathname;
 if(!demo.ok||!storePath.startsWith("/@"))throw Error("Demo store not seeded: "+demo.status+" "+demo.url);
 browser=await chromium.launch(process.env.SHORT_VISIT_CHROME?{executablePath:process.env.SHORT_VISIT_CHROME,headless:true}:{channel:"chrome",headless:true});
 for(const stay of [SHORT_STAY_MS,LONG_STAY_MS])for(const leave of ["navigate","close"])for(let run=1;run<=RUNS;run++){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try{
   const page=await context.newPage();const cdp=await context.newCDPSession(page);
   await cdp.send("Emulation.setCPUThrottlingRate",{rate:4});
   const before=hits.length;
   const reply=await page.goto(LOCAL+storePath,{waitUntil:"load",timeout:60000});
   if(reply?.status()!==200)throw Error("HTTP "+reply?.status()+" "+storePath);
   await page.waitForTimeout(stay);
   if(leave==="navigate")await page.goto("about:blank");else await page.close({runBeforeUnload:true});
   // A request that did leave has this long to land; one that never left never will.
   await new Promise(accept=>setTimeout(accept,SETTLE_MS));
   const visits=hits.slice(before).filter(hit=>JSON.parse(hit.body).k==="v");
   const result={stay,leave,run,visits:visits.length,checked:visits.every(hit=>hit.checked)};
   console.log("STORE_SHORT_VISIT:"+JSON.stringify(result));
   if(visits.length!==1||!result.checked)failed=true;
  }finally{await context.close().catch(()=>{});}
 }
}catch(error){failed=true;console.error(error);}finally{
 await browser?.close().catch(error=>console.error("browser close failed",error));
 if(app.exitCode===null){const gone=new Promise(done=>app.once("exit",done));app.kill("SIGTERM");await Promise.race([gone,new Promise(done=>setTimeout(done,15000))]);if(app.exitCode===null)app.kill("SIGKILL");}
 await new Promise(done=>proxy.close(()=>done()));
 await services?.close?.().catch(error=>console.error("stand-ins close failed",error));
}
if(failed)console.error("STORE_SHORT_VISIT_FAILED: a visit that left the store, or one that stayed past the pause, was not counted once, checked.");
process.exitCode=failed?1:0;
