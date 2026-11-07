import {build} from "esbuild";
import {testAliases,testEnvironment} from "./test-config.mjs";
import {spawnSync} from "node:child_process";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,"..");
const out=mkdtempSync(resolve(tmpdir(),"codex-g1963-"));
try{for(const file of process.argv.slice(2)){
const bundle=resolve(out,"proof.cjs");
const alias=testAliases(file,root,here);
if(["review-g2-card-read-completeness.test.ts","g1963-partial-card-read.proof.ts","g1963-remove-race.proof.ts"].includes(file))alias["next/headers"]=resolve(here,"security/next-headers.ts");
await build({entryPoints:[resolve(here,file)],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",alias,banner:{js:"globalThis.fetch = async () => { throw Error('No external network in G review'); };"}});
const result=spawnSync(process.execPath,[bundle],{cwd:root,env:testEnvironment(process.env),stdio:"inherit"});
if(result.status!==0)process.exitCode=1;
}}finally{rmSync(out,{recursive:true,force:true});}
