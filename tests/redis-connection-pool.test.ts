import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {createLocalRedisPool} from './redis-connection-pool';

/** Actual loopback TCP, with a deliberately small independent RESP server.
 * No application database, provider, credentials or network service is used. */
async function server(reply:(parts:string[],socket:Socket)=>void){
 const sockets=new Set<Socket>();let connections=0;const seen:string[][]=[];
 const listener=createServer(socket=>{
  connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   for(;;){
    const first=buffer.indexOf('\r\n');if(first<0)return;
    const count=Number(buffer.toString('utf8',1,first));let at=first+2;const parts:string[]=[];
    for(let i=0;i<count;i++){
     const end=buffer.indexOf('\r\n',at);if(end<0)return;
     const size=Number(buffer.toString('utf8',at+1,end)),start=end+2;if(buffer.length<start+size+2)return;
     parts.push(buffer.toString('utf8',start,start+size));at=start+size+2;
    }
    buffer=buffer.subarray(at);seen.push(parts);reply(parts,socket);if(!buffer.length)return;
   }
  });
 });
 await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const address=listener.address();assert.ok(address&&typeof address==='object');
 return {port:address.port,seen,get connections(){return connections;},close:async()=>{
  for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>listener.close(()=>resolve()));
 }};
}
function bulk(value:string){return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;}
async function withServer(reply:Parameters<typeof server>[0],body:(fixture:Awaited<ReturnType<typeof server>>)=>Promise<void>){
 const fixture=await server(reply),priorFlag=process.env.MARKTMORGEN_REDIS_INTEGRATION,priorPort=process.env.CONFIRMATION_ORIGIN_REDIS_PORT;
 process.env.MARKTMORGEN_REDIS_INTEGRATION='1';process.env.CONFIRMATION_ORIGIN_REDIS_PORT=String(fixture.port);
 try{await body(fixture);}finally{
  if(priorFlag===undefined)delete process.env.MARKTMORGEN_REDIS_INTEGRATION;else process.env.MARKTMORGEN_REDIS_INTEGRATION=priorFlag;
  if(priorPort===undefined)delete process.env.CONFIRMATION_ORIGIN_REDIS_PORT;else process.env.CONFIRMATION_ORIGIN_REDIS_PORT=priorPort;
  await fixture.close();
 }
}

test('scoped Redis batches reuse at most four connections without dropping or reordering commands',async()=>{
 await withServer((parts,socket)=>socket.write(bulk(parts[1])),async fixture=>{
  const pool=createLocalRedisPool();
  try{
   for(let i=0;i<80;i++)assert.deepEqual(await pool.pipeline([['PING','sequential-'+i]]),['sequential-'+i]);
   const replies=await Promise.all(Array.from({length:20},(_,i)=>pool.pipeline([['PING','parallel-'+i],['PING','second-'+i]])));
   replies.forEach((value,i)=>assert.deepEqual(value,['parallel-'+i,'second-'+i]));
   assert.equal(fixture.seen.length,120);
   assert.ok(fixture.connections<=4,`connection bound exceeded: ${fixture.connections}`);
  }finally{pool.close();}
 });
});

test('fragmented multibyte and nested RESP replies remain one exact batch',async()=>{
 await withServer((parts,socket)=>{
  const wire=Buffer.from(`*4\r\n${bulk(parts[1])}$-1\r\n:7\r\n*1\r\n+OK\r\n`);
  socket.write(wire.subarray(0,9));setImmediate(()=>socket.write(wire.subarray(9)));
 },async fixture=>{
  const pool=createLocalRedisPool();
  try{assert.deepEqual(await pool.pipeline([['PING','原😀choice']]),[['原😀choice',null,7,['OK']]]);assert.equal(fixture.connections,1);}
  finally{pool.close();}
 });
});

test('a lost reply fails active, queued and future batches without reconnecting or replaying',async()=>{
 await withServer((_parts,socket)=>socket.destroy(),async fixture=>{
  const pool=createLocalRedisPool();
  try{
   const replies=await Promise.allSettled(Array.from({length:20},(_,i)=>pool.pipeline([['EVAL','unique-'+i]])));
   assert.ok(replies.every(r=>r.status==='rejected'));
   assert.ok(fixture.seen.length>0&&fixture.seen.length<=4);
   assert.equal(new Set(fixture.seen.map(parts=>parts[1])).size,fixture.seen.length,'no command was replayed');
   const connections=fixture.connections,commands=fixture.seen.length;
   await assert.rejects(pool.pipeline([['EVAL','later']]));
   assert.equal(fixture.connections,connections);assert.equal(fixture.seen.length,commands);
  }finally{pool.close();}
 });
});

test('closing an owned scope rejects its blocked waiters and leaves no TCP handles',async()=>{
 await withServer(()=>{},async fixture=>{
  const pool=createLocalRedisPool();
  const replies=Promise.allSettled(Array.from({length:20},(_,i)=>pool.pipeline([['PING','held-'+i]])));
  try{
   for(let i=0;i<100&&fixture.seen.length<4;i++)await new Promise<void>(resolve=>setImmediate(resolve));
   assert.equal(fixture.seen.length,4);pool.close();
   assert.ok((await replies).every(r=>r.status==='rejected'));
   await assert.rejects(pool.pipeline([['PING','after-close']]),/pool closed/);
   assert.equal(fixture.connections,4);
  }finally{pool.close();}
 });
});

test('empty batches add no connections and construction requires the disposable opt-in',async()=>{
 await withServer((_parts,socket)=>socket.write('+OK\r\n'),async fixture=>{
  const flag=process.env.MARKTMORGEN_REDIS_INTEGRATION,port=process.env.CONFIRMATION_ORIGIN_REDIS_PORT;
  try{
   delete process.env.MARKTMORGEN_REDIS_INTEGRATION;assert.throws(()=>createLocalRedisPool(),/Dedicated disposable loopback Redis/);
   process.env.MARKTMORGEN_REDIS_INTEGRATION='1';
   for(const invalid of ['0','1023','65536','1.5','not-a-port']){
    process.env.CONFIRMATION_ORIGIN_REDIS_PORT=invalid;assert.throws(()=>createLocalRedisPool(),/Dedicated disposable loopback Redis/);
   }
  }finally{process.env.MARKTMORGEN_REDIS_INTEGRATION=flag;process.env.CONFIRMATION_ORIGIN_REDIS_PORT=port;}
  const pool=createLocalRedisPool();try{assert.deepEqual(await pool.pipeline([]),[]);assert.equal(fixture.connections,0);}finally{pool.close();}
 });
});
