import assert from "node:assert/strict";
import {test} from "node:test";
import {spawn,spawnSync} from "node:child_process";
import {createConnection,createServer} from "node:net";
import {once} from "node:events";
import {MemoryRedis} from "@/lib/redis-memory";

const arity=(name:string)=>`ERR wrong number of arguments for '${name.toLowerCase()}' command`;
const invalid:[(string|number)[],string][]=[];
for(const name of ["DEL","MGET"])invalid.push([[name],arity(name)]);
for(const name of ["HDEL","SADD","LPUSH","RPUSH","HMGET"]){
 for(const tail of [[],["key"]])invalid.push([[name,...tail],arity(name)]);
}
for(const tail of [[],["key"],["key","field"],["key","field","value","orphan"]])invalid.push([["HSET",...tail],arity("HSET")]);
for(const tail of [[],["key"],["key",1],["key","NX"]])invalid.push([["ZADD",...tail],arity("ZADD")]);
for(const tail of [["key",1,"member",2],["key","NX",1],["key","NX",1,"member",2]])invalid.push([["ZADD",...tail],"ERR syntax error"]);

for(const [command,message] of invalid)test(`Redis rejects incomplete ${JSON.stringify(command)} before touching data`,()=>{
 const store=new MemoryRedis();
 store.run(["SET","","empty-key-value"]);
 store.run(["SET","key","existing-value"]);
 assert.throws(()=>store.run(command),{message});
 assert.equal(store.run(["GET",""]),"empty-key-value");
 assert.equal(store.run(["GET","key"]),"existing-value");
 assert.deepEqual(store.keys(),["","key"]);
});

test("an incomplete HSET cannot apply its complete prefix",()=>{
 const store=new MemoryRedis();store.run(["HSET","hash","original","kept"]);
 assert.throws(()=>store.run(["HSET","hash","new","value","orphan"]),{message:arity("HSET")});
 assert.deepEqual(store.run(["HGETALL","hash"]),["original","kept"]);
});

test("valid minimum and variadic commands retain their existing replies",()=>{
 const store=new MemoryRedis();
 store.run(["HSET","hash","a","1","b",2]);
 assert.deepEqual(store.run(["HMGET","hash","a","b"]),["1","2"]);
 assert.equal(store.run(["HDEL","hash","a","b"]),2);
 assert.equal(store.run(["SADD","set","a","b"]),2);
 assert.equal(store.run(["LPUSH","left","a","b"]),2);
 assert.equal(store.run(["RPUSH","right","a","b"]),2);
 assert.deepEqual(store.run(["LRANGE","left",0,-1]),["b","a"]);
 assert.deepEqual(store.run(["LRANGE","right",0,-1]),["a","b"]);
 store.run(["ZADD","sorted","NX",1,"a",2,"b"]);
 assert.equal(store.run(["ZSCORE","sorted","a"]),"1");
 assert.equal(store.run(["ZSCORE","sorted","b"]),"2");
 store.run(["SET","","empty"]);
 assert.deepEqual(store.run(["MGET","","missing"]),["empty",null]);
 assert.equal(store.run(["DEL","","left","right"]),3);
});

test("pipeline rejects an invalid command without applying it or later commands",async()=>{
 const store=new MemoryRedis();
 await assert.rejects(store.pipeline([["SET","before","kept"],["HSET","bad"],["SET","after","absent"]]),{message:arity("HSET")});
 assert.equal(store.run(["GET","before"]),"kept");
 assert.equal(store.run(["EXISTS","bad"]),0);
 assert.equal(store.run(["GET","after"]),null);
});

test("error wording is independent of command casing",()=>{
 assert.throws(()=>new MemoryRedis().run(["hSeT","hash"]),{message:arity("HSET")});
});

test("Redis 7 independently confirms every invalid command and error",{skip:!process.env.REDIS_ARITY_SERVER},async()=>{
 const binary=process.env.REDIS_ARITY_SERVER!;
 const version=spawnSync(binary,["--version"],{encoding:"utf8"});
 assert.equal(version.status,0);assert.match(version.stdout,/Redis server v=7\./);
 const reservation=createServer();
 await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));
 const address=reservation.address();assert.ok(address&&typeof address!=="string");
 const port=address.port;
 await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
 const child=spawn(binary,["--bind","127.0.0.1","--port",String(port),"--save","","--appendonly","no"],{stdio:["ignore","pipe","pipe"]});
 const closed=once(child,"close");
 try{
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error("Redis did not report readiness")),5000);
   child.once("error",error=>{clearTimeout(timer);reject(error);});
   child.once("exit",()=>{clearTimeout(timer);reject(Error("Redis exited before readiness"));});
   child.stdout.on("data",chunk=>{if(/ready to accept connections/i.test(String(chunk))){clearTimeout(timer);resolve();}});
  });
  for(const [command,message] of invalid){
   const native=await new Promise<string>((resolve,reject)=>{
    const socket=createConnection({host:"127.0.0.1",port});let reply="";
    socket.once("error",reject);
    socket.once("connect",()=>socket.write(`*${command.length}\r\n`+command.map(value=>{const text=String(value);return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;}).join("")));
    socket.on("data",chunk=>{reply+=String(chunk);if(reply.endsWith("\r\n")){socket.end();resolve(reply);}});
   });
   assert.equal(native,"-"+message+"\r\n",JSON.stringify(command));
  }
 }finally{child.kill("SIGTERM");await closed;}
});
