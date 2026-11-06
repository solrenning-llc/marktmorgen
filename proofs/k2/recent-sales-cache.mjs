/** Local proof runner; existing repository aliases/environment, no inherited credentials or external services. */
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const root=resolve(process.argv[2]||process.cwd()),require=createRequire(join(root,"package.json"));
const {build}=require("esbuild"),{testAliases,testEnvironment}=await import(pathToFileURL(join(root,"tests/test-config.mjs")));
const folder=mkdtempSync(join(tmpdir(),"k2-public-cache-"));
try{
 const name="k-recent-sales-cache-read.proof.ts",out=join(folder,"proof.cjs");
 await build({entryPoints:[join(root,"tests",name)],outfile:out,bundle:true,platform:"node",format:"cjs",alias:testAliases(name,root,join(root,"tests")),logLevel:"error"});
 const result=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment({PATH:process.env.PATH,HOME:process.env.HOME}),stdio:"inherit"});
 process.exitCode=result.status??1;
}finally{rmSync(folder,{recursive:true,force:true});}
