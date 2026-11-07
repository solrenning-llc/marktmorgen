import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
const root = resolve(import.meta.dirname, ".."), here = join(root, "tests");
for (const file of process.argv.slice(2)) {
  const alias = testAliases(file.includes("p-review-2954") ? "nx-community-mail.test.ts" : file, root, here);
  if (process.env.P2954_SOURCE === "red") {
    for (const name of ["community-event-mail", "community-mail", "community-events"]) {
      if (name === "community-events" && file !== "rsvp-list-exact.test.ts") continue;
      alias[`@/lib/${name}`] = `/tmp/p2954-red-modules/lib/${name}.ts`;
    }
  }
  const source = `import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
globalThis.fetch=()=>{throw Error('review external network prohibited')};
process.on('beforeExit',()=>console.log('MemoryRedis dispatches:',count));
import(${JSON.stringify("./tests/" + file)});`;
  const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false, platform: "node", format: "cjs", alias });
  const run = spawnSync(process.execPath, ["--max-old-space-size=512", "-"], { cwd: root, input: bundle.outputFiles[0].text, encoding: "utf8", env: testEnvironment(process.env), timeout: 120000, maxBuffer: 256 * 1024 });
  console.log(JSON.stringify({ file, exit: run.status, error: run.error?.message }));
  process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? "");
  if (run.status !== 0 || run.error) process.exitCode = 1;
}
