import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
const root = resolve(import.meta.dirname, ".."), here = join(root, "tests");
for (const file of process.argv.slice(2)) {
  const alias = testAliases(file, root, here);
  if (process.env.P3035_PREVIOUS === "1") {
    const previous = process.env.P3035_OLD_MODULES_ROOT ?? "/tmp/p3035-07e302";
    for (const name of ["student-bulk", "student-bulk-rules"]) alias["@/lib/" + name] = join(previous, "lib", name + ".ts");
    alias["@/app/api/store/students/route"] = join(previous, "app/api/store/students/route.ts");
  }
  const source = `import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
globalThis.fetch=()=>{throw Error('review external network prohibited')};
process.on('exit',()=>console.log('MemoryRedis dispatches:',count));
import(${JSON.stringify("./tests/" + file)});`;
  const bundle = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,platform:"node",format:"cjs",alias});
  const run = spawnSync(process.execPath,["--max-old-space-size=512","-"],{cwd:root,input:bundle.outputFiles[0].text,encoding:"utf8",env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024});
  console.log(JSON.stringify({file,exit:run.status,error:run.error?.message}));
  process.stdout.write(run.stdout??"");process.stderr.write(run.stderr??"");
  if(run.status!==0||run.error)process.exitCode=1;
}
