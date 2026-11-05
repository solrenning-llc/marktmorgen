/** Optional independent G proof. Owned Redis only; no production service. */
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {spawn} from 'node:child_process';
import {createConnection,createServer} from 'node:net';
import {once} from 'node:events';
import {MemoryRedis} from '@/lib/redis-memory';
let child,closed,port;
before(async()=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));
 child=spawn('/tmp/marktmorgen-redis-7.4.12/src/redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});closed=once(child,'close');
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned Redis readiness missing')),5000);child.once('error',reject);child.stdout.on('data',c=>{if(/ready to accept connections/i.test(String(c))){clearTimeout(timer);resolve();}});});
});
after(async()=>{child?.kill('SIGTERM');if(closed)await closed;});
async function native(command){return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});let reply='';socket.once('error',reject);socket.once('connect',()=>socket.write(`*${command.length}\r\n`+command.map(v=>`$${Buffer.byteLength(String(v))}\r\n${v}\r\n`).join('')));socket.on('data',c=>{reply+=c;if(reply.endsWith('\r\n')){socket.end();resolve(reply);}});});}
for(const name of ['SREM','ZREM']){
 test(`G ${name}: missing member is rejected before missing/string/collection lookup, any command case`,async()=>{
  for(const state of ['missing','string','collection'])for(const casing of [name,name.toLowerCase(),name[0]+name.slice(1).toLowerCase()])for(const tail of [[],['g-key']]){
   await native(['FLUSHDB']);const memory=new MemoryRedis();const seed=state==='string'?['SET','g-key','kept']:state==='collection'?(name==='SREM'?['SADD','g-key','kept']:['ZADD','g-key',1,'kept']):null;
   if(seed){memory.run(seed);await native(seed);}const before=JSON.stringify([...memory.keys()]);const command=[casing,...tail],message=`ERR wrong number of arguments for '${name.toLowerCase()}' command`;
   assert.equal(await native(command),'-'+message+'\r\n');assert.throws(()=>memory.run(command),{message});assert.equal(JSON.stringify([...memory.keys()]),before);
   if(state==='string')assert.equal(memory.run(['GET','g-key']),'kept');
   if(state==='collection')assert.equal(memory.run(name==='SREM'?['SISMEMBER','g-key','kept']:['ZSCORE','g-key','kept']),name==='SREM'?1:'1');
  }
 });
 test(`G ${name}: minimum, duplicate, absent and variadic members match Redis counts`,async()=>{
  await native(['FLUSHDB']);const memory=new MemoryRedis();const seed=name==='SREM'?['SADD','g-key','a','b','c']:['ZADD','g-key',1,'a',2,'b',3,'c'];memory.run(seed);await native(seed);
  for(const command of [[name,'g-key','absent'],[name,'g-key','a','a'],[name,'g-key','b'],[name,'g-key','c','absent']])assert.equal(await native(command),':'+memory.run(command)+'\r\n');
 });
}
