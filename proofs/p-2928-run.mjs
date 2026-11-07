import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
const root = resolve(import.meta.dirname, '..'), here = join(root, 'tests');
for (const file of process.argv.slice(2)) {
  const alias = testAliases(file, root, here);
  const old = process.env.P2928_OLD === '1';
  if(old) alias['@/lib/takedown']='/tmp/p2928-old-takedown.ts';
  const entry='./tests/'+file;
  const source = `import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
globalThis.fetch=()=>{throw Error('review external network prohibited')};
process.on('exit',()=>console.log('MemoryRedis dispatches:',count));
import(${JSON.stringify(entry)});`;
  const built = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,metafile:true,platform:'node',format:'cjs',alias,nodePaths:[join(root,'node_modules')]});
  const child = spawnSync(process.execPath,['--max-old-space-size=512','-'],{cwd:root,input:built.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024});
  console.log(JSON.stringify({file,old,exit:child.status,error:child.error?.message}));
  process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
  if(child.status!==0||child.error)process.exitCode=1;
}
