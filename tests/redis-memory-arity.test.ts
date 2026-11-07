import assert from "node:assert/strict";
import {test} from "node:test";
import {spawn,spawnSync} from "node:child_process";
import {createConnection,createServer} from "node:net";
import {once} from "node:events";
import {MemoryRedis} from "@/lib/redis-memory";
import * as guard from "@/lib/request-guard";

// Read through the module, so this RED builds before the scripts exist (undefined then).
const {TAKE_MANY,GIVE_BACK_MANY}=guard as unknown as {TAKE_MANY:string;GIVE_BACK_MANY:string};

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

/**
 * lib/request-guard.ts TAKE_MANY and GIVE_BACK_MANY, as lib/redis-memory.ts
 * runs them and as Redis 7 runs them: the same answers, the same count and
 * whether the count has an end (second pre-review of 279 [H3-4] unit 2).
 * Each step is [command, what to compare]: "reply" the reply itself, "ends"
 * only whether it is a time (a whole number above zero, the window's end in
 * ms), "error" only that it failed.
 */
type Step=[(string|number)[],"reply"|"ends"|"error"];
const took=(key:string,n:number,limit=1000,window=86400):(string|number)[]=>["EVAL",TAKE_MANY,1,key,n,limit,window];
// ENDS stands for the window's end the last TAKE_MANY answered, LATER for a moment after it; each is put in when sent.
const ENDS="<ends>",LATER="<later>";
const SCENARIOS:{name:string;steps:Step[]}[]=[
 {name:"a first take starts the window",steps:[[took("c",25),"ends"],[["GET","c"],"reply"]]},
 {name:"a take past the limit takes nothing",steps:[[["SET","c","990","EX",86400],"reply"],[took("c",25),"reply"],[["GET","c"],"reply"],[took("c",10),"ends"],[["GET","c"],"reply"]]},
 {name:"a count left below zero with no end is counted from zero and given the window",steps:[[["SET","c","-25"],"reply"],[took("c",1),"ends"],[["GET","c"],"reply"],[["TTL","c"],"reply"]]},
 {name:"a count with no end is given the window",steps:[[["SET","c","5"],"reply"],[took("c",1),"ends"],[["GET","c"],"reply"],[["TTL","c"],"reply"]]},
 {name:"a count that is not a number is never room",steps:[[["SET","c","abc","EX",60],"reply"],[took("c",1),"error"],[["GET","c"],"reply"]]},
 {name:"given back only in the same window, never below zero, never made anew",steps:[
  [took("c",30),"ends"],
  [["EVAL",GIVE_BACK_MANY,1,"c",5,ENDS],"reply"],[["GET","c"],"reply"],
  [["EVAL",GIVE_BACK_MANY,1,"c",5,LATER],"reply"],
  [["EVAL",GIVE_BACK_MANY,1,"c",26,ENDS],"reply"],[["GET","c"],"reply"],
  [["EVAL",GIVE_BACK_MANY,1,"gone",1,ENDS],"reply"],[["EXISTS","gone"],"reply"],
 ]},
];

/** Runs a scenario through `send`, returning what is compared at each step. */
async function runScenario(send:(command:(string|number)[])=>Promise<{ok:boolean;value:unknown}>,steps:Step[]):Promise<unknown[]>{
 let ends=0;const out:unknown[]=[];
 for(const [template,compare] of steps){
  const command=template.map(part=>part===ENDS?ends:part===LATER?ends+1000:part);
  const got=await send(command);
  if(command[0]==="EVAL"&&command[1]===TAKE_MANY&&got.ok&&typeof got.value==="number"&&got.value>0)ends=got.value;
  out.push(compare==="error"?!got.ok:compare==="ends"?got.ok&&Number.isSafeInteger(got.value)&&(got.value as number)>0:got.ok?got.value:"error");
 }
 return out;
}
const memorySend=(store:MemoryRedis)=>async(command:(string|number)[])=>{try{return{ok:true,value:store.run(command)};}catch{return{ok:false,value:null};}};

const EXPECTED:Record<string,unknown[]>={
 "a first take starts the window":[true,"25"],
 "a take past the limit takes nothing":["OK",0,"990",true,"1000"],
 "a count left below zero with no end is counted from zero and given the window":["OK",true,"1",86400],
 "a count with no end is given the window":["OK",true,"6",86400],
 "a count that is not a number is never room":["OK",true,"abc"],
 "given back only in the same window, never below zero, never made anew":[true,1,"25",0,0,"25",0,0],
};
for(const {name,steps} of SCENARIOS)test(`the in-memory TAKE_MANY and GIVE_BACK_MANY: ${name}`,async()=>{
 assert.deepEqual(await runScenario(memorySend(new MemoryRedis()),steps),EXPECTED[name]);
});

test("Redis 7 runs TAKE_MANY and GIVE_BACK_MANY as the in-memory store does",{skip:!process.env.REDIS_ARITY_SERVER},async()=>{
 const binary=process.env.REDIS_ARITY_SERVER!;
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
   child.stdout.on("data",chunk=>{if(/ready to accept connections/i.test(String(chunk))){clearTimeout(timer);resolve();}});
  });
  // One reply of RESP2: a status, an error, a whole number or a bulk string (null for $-1).
  const send=(command:(string|number)[])=>new Promise<{ok:boolean;value:unknown}>((resolve,reject)=>{
   const socket=createConnection({host:"127.0.0.1",port});let reply="";
   socket.once("error",reject);
   socket.once("connect",()=>socket.write(`*${command.length}\r\n`+command.map(value=>{const text=String(value);return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;}).join("")));
   socket.on("data",chunk=>{
    reply+=String(chunk);
    const line=reply.indexOf("\r\n");if(line<0)return;
    const head=reply.slice(0,line);
    let done:{ok:boolean;value:unknown}|null=null;
    if(head[0]==="+")done={ok:true,value:head.slice(1)};
    else if(head[0]==="-")done={ok:false,value:head.slice(1)};
    else if(head[0]===":")done={ok:true,value:Number(head.slice(1))};
    else if(head==="$-1")done={ok:true,value:null};
    else if(head[0]==="$"){const size=Number(head.slice(1));if(reply.length>=line+2+size+2)done={ok:true,value:reply.slice(line+2,line+2+size)};}
    if(done){socket.end();resolve(done);}
   });
  });
  for(const {name,steps} of SCENARIOS){
   await send(["FLUSHALL"]);
   assert.deepEqual(await runScenario(send,steps),EXPECTED[name],name);
  }
 }finally{child.kill("SIGTERM");await closed;}
});
