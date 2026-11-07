// Bounded documentary replay; no author file or assertion is modified.
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root=process.cwd(), mode=process.argv[2]??"head";
if(!["head","red"].includes(mode))throw Error("Expected head or red");
if(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!=="660c215990976c34b8850834eac2b4c3d2dfe669")throw Error("Copy to exact corrective checkout");
const old=execFileSync("git",["show","b6437e638793a9c08f4781229d94dfbb3f8b736d:docs/meta-requirements.md"],{encoding:"utf8"});
const out=mkdtempSync(join(tmpdir(),"t2916-focal-"));
try {
 const file=join(out,"test.cjs");
 const banner='globalThis.fetch=()=>{throw Error("Provider/network forbidden")};for(const m of ["node:http","node:https"]){const h=require(m);h.request=h.get=()=>{throw Error("Provider/network forbidden")}};'+(mode==="red"?'const fs=require("node:fs"),read=fs.readFileSync;fs.readFileSync=function(p,...args){if(typeof p==="string"&&require("node:path").resolve(p)==='+JSON.stringify(join(root,"docs/meta-requirements.md"))+')return '+JSON.stringify(old)+';return read.call(this,p,...args)};':"");
 await build({entryPoints:[join(root,"tests/meta-requirements-doc.test.ts")],bundle:true,platform:"node",format:"cjs",outfile:file,logLevel:"error",banner:{js:banner},plugins:[{name:"case-ceiling",setup(b){b.onLoad({filter:/\/tests\/check\.ts$/},a=>{const s=readFileSync(a.path,"utf8"),n="checks += 1;";if(!s.includes(n))throw Error("Case observer missing");return {contents:s.replace(n,n+' if(checks>12)throw Error("Twelve-case ceiling");'),loader:"ts"}})}}]});
 const p=spawnSync(process.execPath,["--max-old-space-size=512",file],{cwd:root,encoding:"utf8",timeout:120000,maxBuffer:131072});
 const log=(p.stdout??"")+(p.stderr??"");writeFileSync(join(root,"t-2916-focal-"+mode+".log"),log);
 console.log(JSON.stringify({mode,exit:p.status,error:p.error?.message,summary:log.match(/\d+ checks[^\n]*/g)}));
 process.exitCode=p.status??1;
} finally {rmSync(out,{recursive:true,force:true});}
