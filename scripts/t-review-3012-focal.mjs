// Copy into the exact candidate checkout; no author file is modified.
import { build } from "esbuild";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
const root = process.cwd(), here = join(root, "tests");
const mode = process.argv[2] ?? "head";
const exact = "6da8c75b7534215be040830640b807805fe0bd71";
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== exact) throw Error("Exact corrective candidate required");
if (!["head", "red"].includes(mode)) throw Error("Expected head or red");
const allowed = new Set(["cf2-move-pages.test.ts", "feature-visual-cards.test.ts", "import-paused.test.ts", "clickfunnels-import.test.ts", "feature-mechanisms.test.ts"]);
const files = process.argv.slice(3);
if (!files.length) files.push("cf2-move-pages.test.ts");
if (files.some(f => !allowed.has(f)) || mode === "red" && files.some(f => f !== "cf2-move-pages.test.ts")) throw Error("Unadmitted suite");
const old = execFileSync("git", ["show", "1ee4aa36d230268a395384c6fc66a21b74fbee3d:lib/migration-guides.ts"], { encoding: "utf8" });
const banner = `globalThis.__tRedis=0;globalThis.__tMock=0;let mock=async()=>{throw Error("Network forbidden")};Object.defineProperty(globalThis,"fetch",{configurable:true,get(){return (...a)=>{if(++globalThis.__tMock>100)throw Error("Mock ceiling");return mock(...a)}},set(v){mock=v}});for(const m of ["node:http","node:https"]){const h=require(m);h.request=h.get=()=>{throw Error("Network forbidden")}}process.on("exit",()=>console.log("T_BUDGET "+JSON.stringify({redis:globalThis.__tRedis,httpMock:globalThis.__tMock})));`;
const out = mkdtempSync(join(tmpdir(), "t3012-focal-"));
let failed = 0;
try {
  for (const file of files) {
    const bundle = join(out, file + ".cjs");
    const compiled = await build({entryPoints:[join(here,file)],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",metafile:true,alias:testAliases(file,root,here),banner:{js:banner},plugins:[{name:"bounded-focal",setup(b){
      b.onLoad({filter:/\/lib\/redis-memory\.ts$/},args=>{
        const s=readFileSync(args.path,"utf8"),needle="run(command: (string | number)[]): unknown {";
        if(!s.includes(needle))throw Error("Observer point missing");
        return {contents:s.replace(needle,needle+' if(++(globalThis as any).__tRedis>5000)throw Error("Redis ceiling before dispatch");'),loader:"ts"};
      });
      b.onLoad({filter:/\/tests\/check\.ts$/},args=>{
        const s=readFileSync(args.path,"utf8"),needle="checks += 1;";
        if(!s.includes(needle))throw Error("Case observer missing");
        return {contents:s.replace(needle,needle+' if(checks>250)throw Error("Case ceiling");'),loader:"ts"};
      });
      if(mode==="red")b.onLoad({filter:/\/lib\/migration-guides\.ts$/},()=>({contents:old,loader:"ts"}));
    }}]});
    if(Object.keys(compiled.metafile.inputs).some(p=>p.endsWith("lib/redis.ts")))throw Error("Live Redis graph");
    const p=spawnSync(process.execPath,["--max-old-space-size=512",bundle],{cwd:root,env:testEnvironment(process.env),encoding:"utf8",timeout:120000,maxBuffer:262144});
    const output=(p.stdout??"")+(p.stderr??"");
    writeFileSync(join(root,`t-3012-focal-${mode}-${file}.log`),output);
    console.log(JSON.stringify({file,mode,exit:p.status,error:p.error?.message,summary:output.match(/\d+\/\d+[^\n]*/g),budget:output.match(/T_BUDGET .*/g)}));
    if(p.status!==0)failed++;
  }
} finally {rmSync(out,{recursive:true,force:true});}
process.exitCode=failed?1:0;
