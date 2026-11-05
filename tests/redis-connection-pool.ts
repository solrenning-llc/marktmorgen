/** Test-only, explicitly opted-in loopback transport. Each owned proof closes
 * its pool. Requests are never replayed after a lost reply or disconnect. */
import {createConnection,type Socket} from 'node:net';

type Reply={value:unknown;end:number};
type Request={encoded:string;count:number;resolve:(value:unknown[])=>void;reject:(error:Error)=>void};
type Client={socket:Socket;ready:boolean;active:Request|null;buffer:Buffer};

function parse(buffer:Buffer,start:number):Reply|null{
 const eol=buffer.indexOf('\r\n',start);if(eol<0)return null;
 const kind=String.fromCharCode(buffer[start]),text=buffer.toString('utf8',start+1,eol),next=eol+2;
 if(kind==='+')return {value:text,end:next};
 if(kind==='-')throw Error(text);
 if(kind===':')return {value:Number(text),end:next};
 if(kind==='$'){
  const n=Number(text);if(n===-1)return {value:null,end:next};
  if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid disposable Redis length');
  if(buffer.length<next+n+2)return null;return {value:buffer.toString('utf8',next,next+n),end:next+n+2};
 }
 if(kind==='*'){
  const n=Number(text);if(n===-1)return {value:null,end:next};
  if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid disposable Redis array');
  const out=[];let cursor=next;for(let i=0;i<n;i++){const item=parse(buffer,cursor);if(!item)return null;out.push(item.value);cursor=item.end;}
  return {value:out,end:cursor};
 }
 throw Error('Invalid disposable Redis reply');
}

export function createLocalRedisPool(){
 const port=Number(process.env.CONFIRMATION_ORIGIN_REDIS_PORT);
 if(process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!Number.isInteger(port)||port<1024||port>65535)throw Error('Dedicated disposable loopback Redis required');
 const clients:Client[]=[],waiting:Request[]=[];let stopped:Error|null=null;
 function stop(error:Error){
  if(stopped)return;stopped=error;
  for(const request of waiting.splice(0))request.reject(error);
  for(const client of clients){client.active?.reject(error);client.active=null;client.socket.destroy();}
 }
 function send(client:Client,request:Request){
  client.active=request;client.buffer=Buffer.alloc(0);
  client.socket.setTimeout(5000);if(client.ready)client.socket.write(request.encoded);
 }
 function make():Client{
  const socket=createConnection({host:'127.0.0.1',port}),client:Client={socket,ready:false,active:null,buffer:Buffer.alloc(0)};
  clients.push(client);
  socket.on('connect',()=>{client.ready=true;if(client.active)socket.write(client.active.encoded);});
  socket.on('timeout',()=>stop(Error('Disposable Redis timed out')));
  socket.on('error',stop);
  socket.on('end',()=>stop(Error('Disposable Redis ended before pool close')));
  socket.on('close',()=>{if(!stopped)stop(Error('Disposable Redis closed before pool close'));});
  socket.on('data',chunk=>{
   if(stopped)return;
   try{
    const request=client.active;if(!request)throw Error('Unexpected disposable Redis reply');
    client.buffer=Buffer.concat([client.buffer,chunk]);const replies=[];let cursor=0;
    for(let i=0;i<request.count;i++){const item=parse(client.buffer,cursor);if(!item)return;replies.push(item.value);cursor=item.end;}
    if(cursor!==client.buffer.length)throw Error('Unexpected extra disposable Redis reply');
    client.active=null;client.buffer=Buffer.alloc(0);socket.setTimeout(0);request.resolve(replies);pump();
   }catch(error){stop(error instanceof Error?error:Error('Disposable Redis reply failed'));}
  });
  return client;
 }
 function pump(){
  if(stopped)return;
  while(waiting.length){
   const client=clients.find(c=>!c.active)??(clients.length<4?make():null);
   if(!client)return;send(client,waiting.shift()!);
  }
 }
 return {
  pipeline(commands:(string|number)[][]):Promise<unknown[]>{
   if(stopped)return Promise.reject(stopped);
   if(commands.length===0)return Promise.resolve([]);
   const encoded=commands.map(c=>`*${c.length}\r\n`+c.map(v=>{const s=String(v);return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;}).join('')).join('');
   return new Promise((resolve,reject)=>{waiting.push({encoded,count:commands.length,resolve,reject});pump();});
  },
  close(){stop(Error('Disposable Redis pool closed'));},
 };
}
