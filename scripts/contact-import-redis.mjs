/** Actual Redis proof of the exact import Lua, invoked by the erasure Redis CI entry. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root=resolve(import.meta.dirname,'..');
const temp=mkdtempSync(join(tmpdir(),'contacts-import-redis-'));
try {
 const bundle=join(temp,'import.cjs');
 await build({entryPoints:[join(root,'lib/contacts.ts')],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:{'@':root}});
 const {IMPORT_CONTACTS_WRITE}=createRequire(import.meta.url)(bundle);
 const endpoint=process.env.UPSTASH_REDIS_REST_URL;
 assert.ok(endpoint&&new URL(endpoint).hostname==='127.0.0.1','dedicated loopback Redis bridge required');
 const send=async commands=>{
  const r=await fetch(endpoint+'/pipeline',{method:'POST',headers:{authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'content-type':'application/json'},body:JSON.stringify(commands)});
  assert.equal(r.ok,true); const values=await r.json();
  return values.map(v=>{if(v.error)throw Error(v.error);return v.result;});
 };
 const keys=['q:contact:rows','q:contact:erased','q:contact:agreed','q:contact:unsub'];
 const evalRows=rows=>['EVAL',IMPORT_CONTACTS_WRITE,4,...keys,...rows.flat()];
 const row=(email='fresh@example.com',was='',value='new',add=1,left=0)=>[email,'fingerprint-'+email,was,value,add,left];
 for(const n of [1,50,100,500]){
  await send([['DEL',...keys]]);
  const rows=Array.from({length:n},(_,i)=>row('row'+i+'@example.com'));
  const transaction=await send([['MULTI'],['INFO','commandstats'],evalRows(rows),['INFO','commandstats'],['EXEC']]);
  const [before,result,after]=transaction[4];
  const calls=s=>[...s.matchAll(/calls=(\d+)/g)].reduce((a,m)=>a+Number(m[1]),0);
  const measured=calls(after)-calls(before)-1;
  assert.deepEqual(result,Array(n).fill(1));
  assert.ok(measured<=3*n+9,`actual ${measured} commands exceed native script envelope for ${n} rows`);
  console.log(`Native contact import ${n} rows: ${measured} paid commands`);
 }
 await send([['DEL',...keys],['HSET',keys[1],'fingerprint-erased@example.com','1']]);
 assert.deepEqual((await send([evalRows([row('erased@example.com')])]))[0],[-1]);
 assert.equal((await send([['HLEN',keys[0]]]))[0],0);
 await send([['HSET',keys[0],'changed@example.com','current']]);
 assert.deepEqual((await send([evalRows([row('changed@example.com')])]))[0],[0]);
 const hash=createHash('sha1').update('current').digest('hex');
 assert.deepEqual((await send([evalRows([row('changed@example.com',hash,'stopped',0,1)])]))[0],[1]);
 assert.equal((await send([['GET',keys[3]]]))[0],'1');
 // A lost answer cannot turn the same original snapshot into another write.
 assert.deepEqual((await send([evalRows([row('changed@example.com',hash,'stopped',0,1)])]))[0],[0]);
 assert.equal((await send([['GET',keys[3]]]))[0],'1');
 await send([['DEL',...keys],['SET',keys[2],'invalid']]);
 await assert.rejects(send([evalRows([row()])]),/invalid contact import count/);
 assert.equal((await send([['HLEN',keys[0]]]))[0],0);
 await send([['DEL',...keys]]);
 console.log('Native contact import: erasure fence, stale CAS, counters, replay and preflight checks passed.');
}finally{rmSync(temp,{recursive:true,force:true});}
