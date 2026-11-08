import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
const root = resolve(import.meta.dirname, '..'), here = join(root, 'tests');
for (const file of process.argv.slice(2)) {
  const alias = testAliases(file.startsWith('p-review-2954')?'nx-community-mail.test.ts':file, root, here);
  const old = process.env.P2954_OLD === '1';
  if(old) alias['@/lib/community-event-mail']='/tmp/p2954-old-event-mail.ts';
  const entry='./tests/'+file;
  const source = `import net from 'node:net';import nodeHttp from 'node:http';import https from 'node:https';import tls from 'node:tls';
const deny=()=>{throw Error('review socket/HTTP denied')};net.Socket.prototype.connect=deny;nodeHttp.request=deny;nodeHttp.get=deny;https.request=deny;https.get=deny;tls.connect=deny;
import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
let http=0;let handler=()=>{throw Error('review external network prohibited')};Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return(...args)=>{if(++http>100)throw Error('review mock request ceiling');return handler(...args)}},set(value){handler=value}});
process.on('exit',()=>console.log('MemoryRedis dispatches:',count,'mock HTTP:',http));
import(${JSON.stringify(entry)});`;
  const built = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,metafile:true,platform:'node',format:'cjs',alias,nodePaths:[join(root,'node_modules')]});
  const child = spawnSync(process.execPath,['--max-old-space-size=512','-'],{cwd:root,input:built.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024});
  console.log(JSON.stringify({file,old,exit:child.status,error:child.error?.message}));
  process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
  if(child.status!==0||child.error)process.exitCode=1;
}
