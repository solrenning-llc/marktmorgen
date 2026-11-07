import {build} from "esbuild";
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {testAliases,testEnvironment} from "../tests/test-config.mjs";
const root=process.cwd(),mode=process.argv[2],files=process.argv.slice(3),out=mkdtempSync(join(tmpdir(),"t3062final-"));
if(!["head","availability-red","index-red"].includes(mode))throw Error("mode");
// Copy this runner and the proof into this exact unchanged subject checkout.
// availability-red substitutes ONLY two old runtime modules; final tests/registry remain.
// index-red substitutes directory-index/store from the author RED and its fs source assertion.
const subject="123c8e6c2fe6c8ad25bc081766aa14d6fc27e983";
if(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==subject)throw Error("Wrong subject head");
if(execFileSync("git",["diff",subject,"--name-only","--","app","lib","tests/test-config.mjs","tests/plan-cost-registry.ts"],{encoding:"utf8"}).trim())throw Error("Changed subject source");
const allowed=new Set(["directory-assembly-ceiling.test.ts","affiliate-directory.test.ts","directory-index-unknown.test.ts","directory-index.test.ts","plan-cost-registry.test.ts","store-data-registry.test.ts","closing-families.test.ts","data-recount.test.ts","platform-us-english.test.ts","directory-held-down.test.ts","t-3062-final.proof.ts"]);
if(!files.length||files.some(f=>!allowed.has(f)))throw Error("Unadmitted test");
const old=mode==="index-red"?"7358daa350ad754c9dad454eafdff9eb49fcb487":"c1eab77844d5d5265e2b4c9994525f764d62dd66";
const changed=new Set(mode==="index-red"?["lib/directory-index.ts","lib/store.ts"]:["lib/affiliate-directory.ts","lib/directory-index.ts"]);
let failures=0;
try{for(const file of files){
const bundle=join(out,file+".cjs");
let banner='globalThis.__tRedis=0;globalThis.__tHTTP=0;let mock=()=>{throw Error("External HTTP forbidden")};Object.defineProperty(globalThis,"fetch",{get(){return (...args)=>{if(++globalThis.__tHTTP>100)throw Error("HTTP budget");return mock(...args)}},set(f){mock=f}});for(const n of ["node:http","node:https"]){const m=require(n);m.request=m.get=()=>{throw Error("Network forbidden")}}process.on("exit",()=>console.log("T_BUDGET "+JSON.stringify({redis:globalThis.__tRedis,mockHTTP:globalThis.__tHTTP})));';
if(mode==="index-red")banner+='const fs=require("node:fs"),read=fs.readFileSync;fs.readFileSync=function(p,...a){if(p==="lib/store.ts"||String(p).endsWith("/lib/store.ts"))return '+JSON.stringify(execFileSync("git",["show",old+":lib/store.ts"],{encoding:"utf8"}))+';return read.call(this,p,...a)};';
await build({entryPoints:[join(root,"tests",file)],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",alias:testAliases(file,root,join(root,"tests")),banner:{js:banner},plugins:[{name:"guard",setup(b){b.onLoad({filter:/\.ts$/},a=>{const rel=a.path.slice(root.length+1);let s=readFileSync(a.path,"utf8");if(mode!=="head"&&changed.has(rel))s=execFileSync("git",["show",old+":"+rel],{encoding:"utf8"});if(rel==="lib/redis-memory.ts"){if(!s.includes("run(command: (string | number)[]): unknown {"))throw Error("Missing budget hook");s=s.replace("run(command: (string | number)[]): unknown {",'run(command: (string | number)[]): unknown { if(++(globalThis as any).__tRedis>20000)throw Error("Command ceiling before dispatch");');}return{contents:s,loader:"ts"};});}}]});
const p=spawnSync(process.execPath,["--max-old-space-size=512",bundle],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:262144,encoding:"utf8"});
const log=(p.stdout??"")+(p.stderr??"");writeFileSync("t-3062-final-"+mode+"-"+file+".log",log);console.log(JSON.stringify({file,mode,exit:p.status,summary:log.match(/\d+ checks[^\n]*|ℹ (?:tests|pass|fail) \d+|T_BUDGET .*/g),error:p.error?.message}));if(p.status!==0)failures++;
}}finally{rmSync(out,{recursive:true,force:true});}process.exitCode=failures?1:0;
