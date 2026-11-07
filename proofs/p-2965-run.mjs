import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
const root = resolve(import.meta.dirname, '..'), here = join(root, 'tests');
for (const file of process.argv.slice(2)) {
  const alias = testAliases(file, root, here);
  const old = process.env.P2965_OLD === '1';
  if (old) {
    alias['@/lib/call-series-open'] = '/tmp/p2965-old-call-series-open.ts';
    alias['@/app/api/store/tax/route'] = '/tmp/p2965-old-tax-route.ts';
    alias['@/app/api/store/currency/route'] = '/tmp/p2965-old-currency-route.ts';
  }
  const entry = process.env.P2965_ORIGINAL === '1' ? '/tmp/p2965-original.test.ts' : './tests/' + file;
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {MemoryRedis} from './lib/redis-memory';
const original=MemoryRedis.prototype.run;let count=0;
MemoryRedis.prototype.run=function(command){if(++count>20000)throw Error('review dispatch ceiling');return original.call(this,command)};
globalThis.fetch=()=>{throw Error('review external network prohibited')};
if(${old}){const read=fs.readFileSync;const paths={'components/tax-editor.tsx':'/tmp/p2965-old-tax-editor.tsx','components/payments-panel.tsx':'/tmp/p2965-old-payments-panel.tsx'};fs.readFileSync=function(path,...args){return read.call(this,paths[path]??path,...args)};syncBuiltinESMExports();}
process.on('exit',()=>console.log('MemoryRedis dispatches:',count));
import(${JSON.stringify(entry)});`;
  const plugins = [{name:'frozen-relative-fixtures',setup(api){api.onResolve({filter:/^\.\/(redis-stub|check)$/},args=>args.importer==='/tmp/p2965-original.test.ts'?{path:join(here,args.path.slice(2)+'.ts')}:undefined)}}];
  const built = await build({stdin:{contents:source,resolveDir:root},bundle:true,write:false,metafile:true,platform:'node',format:'cjs',alias,plugins,nodePaths:[join(root,'node_modules')]});
  const child = spawnSync(process.execPath,['--max-old-space-size=512','-'],{cwd:root,input:built.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),timeout:120000,maxBuffer:256*1024});
  console.log(JSON.stringify({file,old,original:process.env.P2965_ORIGINAL==='1',exit:child.status,error:child.error?.message}));
  process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
  if(child.status!==0||child.error)process.exitCode=1;
}
