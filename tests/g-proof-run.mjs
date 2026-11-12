import {build} from "esbuild";
import {testAliases,testEnvironment} from "./test-config.mjs";
import {spawnSync} from "node:child_process";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,"..");
const out=mkdtempSync(resolve(tmpdir(),"codex-g-proof-"));
try{for(const file of process.argv.slice(2)){
const bundle=resolve(out,"proof.cjs");
await build({entryPoints:[resolve(here,file)],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",alias:testAliases(file,root,here)});
const result=spawnSync(process.execPath,[bundle],{cwd:root,env:testEnvironment(process.env),stdio:"inherit"});
if(result.status!==0)process.exitCode=1;
}}finally{rmSync(out,{recursive:true,force:true});}
