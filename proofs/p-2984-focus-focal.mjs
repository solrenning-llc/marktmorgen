import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
const root = resolve(import.meta.dirname, ".."), here = join(root, "tests");
for (const file of process.argv.slice(2)) {
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
globalThis.fetch=()=>{throw Error('review external network prohibited')};
if(process.env.P2984_PREVIOUS==='1'){const read=fs.readFileSync;fs.readFileSync=function(path,...args){return read.call(this,path==='components/email-studio.tsx'?(process.env.P2984_OLD_COMPONENT??'/tmp/p2984-red-source/components/email-studio.tsx'):path,...args)};syncBuiltinESMExports();}
process.on('exit',()=>console.log('MemoryRedis dispatches:',count));
import(${JSON.stringify("./tests/" + file)});`;
  const bundle = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,platform:"node",format:"cjs",alias:testAliases(file,root,here)});
  const run = spawnSync(process.execPath,["--max-old-space-size=512","-"],{cwd:root,input:bundle.outputFiles[0].text,encoding:"utf8",env:testEnvironment(process.env),timeout:120000,maxBuffer:128*1024});
  console.log(JSON.stringify({file,exit:run.status,error:run.error?.message}));
  process.stdout.write(run.stdout??"");process.stderr.write(run.stderr??"");
  if(run.status!==0||run.error)process.exitCode=1;
}
