import {build} from "esbuild";
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {testAliases,testEnvironment} from "../tests/test-config.mjs";
const root=process.cwd(),mode=process.argv[2],files=process.argv.slice(3),out=mkdtempSync(join(tmpdir(),"t3181-"));
if(!["head","red"].includes(mode))throw Error("mode");
// Copy this runner and the proof into this exact unchanged subject checkout.
// red substitutes ONLY pre-admission affiliate-directory.ts; all FINAL tests and registry remain.
// Historical T probes are untouched; the new lease probe is independent and conditional.
const subject="6337d4dbe9f04f28f2d2fcee47feb268df57427a";
if(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==subject)throw Error("Wrong subject head");
if(execFileSync("git",["diff",subject,"--name-only","--","app","lib","tests/test-config.mjs","tests/plan-cost-registry.ts"],{encoding:"utf8"}).trim())throw Error("Changed subject source");
const allowed=new Set(["closed-store-unknown.test.ts", "closed-store.test.ts", "store-closing-fair.test.ts", "closing-families.test.ts", "t-3099-backoff.proof.ts", "t-3181-batch-ack.proof.ts"]);
if(!files.length||files.some(f=>!allowed.has(f)))throw Error("Unadmitted test");
const old="55cb544e3";
const changed=new Set(["lib/closed-store-data.ts"]);
let failures=0;
try{for(const file of files){
const bundle=join(out,file+".cjs");
let banner='globalThis.__tRedis=0;globalThis.__tHTTP=0;let mock=()=>{throw Error("External HTTP forbidden")};Object.defineProperty(globalThis,"fetch",{get(){return (...args)=>{if(++globalThis.__tHTTP>100)throw Error("HTTP budget");return mock(...args)}},set(f){mock=f}});for(const n of ["node:http","node:https"]){const m=require(n);m.request=m.get=()=>{throw Error("Network forbidden")}}process.on("exit",()=>console.log("T_BUDGET "+JSON.stringify({redis:globalThis.__tRedis,mockHTTP:globalThis.__tHTTP})));';
await build({entryPoints:[join(root,"tests",file)],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",alias:testAliases(file,root,join(root,"tests")),banner:{js:banner},plugins:[{name:"guard",setup(b){b.onLoad({filter:/\.ts$/},a=>{const rel=a.path.slice(root.length+1);let s=readFileSync(a.path,"utf8");if(mode!=="head"&&changed.has(rel))s=execFileSync("git",["show",old+":"+rel],{encoding:"utf8"});if(rel==="lib/redis-memory.ts"){if(!s.includes("run(command: (string | number)[]): unknown {"))throw Error("Missing budget hook");s=s.replace("run(command: (string | number)[]): unknown {",'run(command: (string | number)[]): unknown { if(++(globalThis as any).__tRedis>20000)throw Error("Command ceiling before dispatch");');}return{contents:s,loader:"ts"};});}}]});
const p=spawnSync(process.execPath,["--max-old-space-size=512",bundle],{cwd:root,env:testEnvironment(process.env),timeout:120000,maxBuffer:262144,encoding:"utf8"});
const log=(p.stdout??"")+(p.stderr??"");writeFileSync("t-3181-"+mode+"-"+file+".log",log);console.log(JSON.stringify({file,mode,exit:p.status,summary:log.match(/\d+ checks[^\n]*|ℹ (?:tests|pass|fail) \d+|T_BUDGET .*/g),error:p.error?.message}));if(p.status!==0)failures++;
}}finally{rmSync(out,{recursive:true,force:true});}process.exitCode=failures?1:0;
