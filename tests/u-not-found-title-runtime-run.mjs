import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const [root, mode = "final"] = process.argv.slice(2);
const req = createRequire(join(root, "package.json"));
const { build } = req("esbuild");
const outfile = `/tmp/u-not-found-runtime-${mode}.cjs`;
const mocks = {
 "@/lib/store": `export const normaliseHandle = x => x; export async function storeForPage(){ const s=globalThis.__uNotFound; if(globalThis.__uTotals.reads>=100)throw Error("store budget before dispatch");globalThis.__uTotals.reads++;s.reads++;if(s.failure)throw Error("synthetic unavailable");return s.store; }`,
 "next/headers": `export async function headers(){const s=globalThis.__uNotFound;if(globalThis.__uTotals.headers>=100)throw Error("header budget before dispatch");globalThis.__uTotals.headers++;s.headers++;return new Map([["x-nimbus-store",s.asked]]);}`,
 "@/lib/store-look": `export const lookStyle=()=>({});`,
 "@/app/not-found": `import {createElement} from "react";export default function F(){return createElement("p",null,"Site fallback")}`,
 "next/link": `import {createElement} from "react";export default function Link({children,...props}){return createElement("a",props,children)}`,
};
await build({entryPoints:[join(root,"tests/u-not-found-title-runtime.proof.ts")], bundle:true, platform:"node", format:"cjs", outfile, logLevel:"error", banner:{js:`globalThis.__uTotals={reads:0,headers:0};process.once('exit',()=>console.log('ADMITTED',JSON.stringify(globalThis.__uTotals)));require('node:net').Socket.prototype.connect=function(){throw Error('external sockets denied')};globalThis.fetch=async()=>{throw Error('external HTTP denied before dispatch')};`}, plugins:[{name:"bounded-route-fixtures",setup(b){
 b.onResolve({filter:/^(?:@\/lib\/(?:store|store-look)|@\/app\/not-found|next\/(?:headers|link))$/},a=>({path:a.path,namespace:"fixture"}));
 b.onLoad({filter:/.*/,namespace:"fixture"},a=>({contents:mocks[a.path],resolveDir:root,loader:"js"}));
 if(mode==="mutant")b.onLoad({filter:/not-found\.tsx$/},a=>{
 let text=readFileSync(a.path,"utf8");if(!a.path.includes("[handle]"))return;
 const old='title: `${w.missingTitle} — ${store.name}`';if(!text.includes(old))throw Error("mutant guard missing");
 text=text.replace(old,'title: "Not here — Marktmorgen"');return {contents:text,loader:"tsx"};
 });
}}]});
const run=spawnSync(process.execPath,["--max-old-space-size=512",outfile],{cwd:root,timeout:120000,maxBuffer:256*1024,encoding:"utf8",env:{...process.env,NODE_ENV:"test"}});
const output=(run.stdout||"")+(run.stderr||"");writeFileSync(`/tmp/u-not-found-runtime-${mode}.log`,output);console.log(output);console.log("EXIT",run.status);if(run.error)throw run.error;if(mode==="final"&&run.status!==0)throw Error("route proof failed");if(mode==="mutant"&&run.status===0)throw Error("mutation survived");
