import {build} from "esbuild";
import {spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {testAliases,testEnvironment} from "../tests/test-config.mjs";
const root=process.cwd(),here=join(root,"tests"),out=mkdtempSync(join(tmpdir(),"t2852-"));
const files=process.argv.slice(2);let failures=0;
const allowed=new Set(["blob-doors-cost.test.ts","plan-cost-registry.test.ts","plan-margin.test.ts","read-ceilings.test.ts","margin-alignment.test.ts","picture-upload-costs.test.ts","limits-proposal.test.ts","pricing-usage-proposal.test.ts"]);
try{for(const file of files){
if(!allowed.has(file))throw Error("Unadmitted test");
const p=join(out,file+".cjs");await build({entryPoints:[join(here,file)],bundle:true,platform:"node",format:"cjs",outfile:p,logLevel:"error",alias:testAliases(file,root,here),banner:{js:'globalThis.__tRedis=0;globalThis.fetch=()=>{throw Error("No external network")};for(const m of ["node:http","node:https"]){const h=require(m);h.request=h.get=()=>{throw Error("No external network")}};process.on("exit",()=>console.log("T_REDIS="+globalThis.__tRedis));'},plugins:[{name:"budget",setup(b){b.onLoad({filter:/\/lib\/redis-memory\.ts$/},a=>{const s=readFileSync(a.path,"utf8"),n="run(command: (string | number)[]): unknown {";if(!s.includes(n))throw Error("observer");return {contents:s.replace(n,n+' if(++(globalThis as any).__tRedis>5000)throw Error("Command ceiling before dispatch");'),loader:"ts"}});b.onLoad({filter:/\/tests\/check\.ts$/},a=>({contents:readFileSync(a.path,"utf8").replace("checks += 1;",'checks += 1; if(checks>500)throw Error("Case ceiling");'),loader:"ts"}));}}]});
const r=spawnSync(process.execPath,["--max-old-space-size=512",p],{cwd:root,env:testEnvironment(process.env),encoding:"utf8",timeout:120000,maxBuffer:262144});process.stdout.write(r.stdout??"");process.stderr.write(r.stderr??"");if(r.status!==0)failures++;console.log(JSON.stringify({file,exit:r.status,error:r.error?.message}));}
}finally{rmSync(out,{recursive:true,force:true});}process.exitCode=failures?1:0;
