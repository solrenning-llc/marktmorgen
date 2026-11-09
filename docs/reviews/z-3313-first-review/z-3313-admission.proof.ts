import {GET} from "@/app/api/backup/files/route";
import {blobWorld,resetBlobWorld} from "../../../tests/backup-files-world";
import {store as redis} from "../../../tests/redis-stub";
import {done,is} from "../../../tests/check";
const store="0123456789abcdef0123456789abcdef",secret="z3313-synthetic-route-secret-0123456789",key=`nl:backup:files:day:${new Date().toISOString().slice(0,10)}:blob`;
const pipeline=redis.pipeline;let reply:unknown|undefined,commands=0,bytes=0;
redis.pipeline=async cs=>{commands+=cs.length;bytes+=Buffer.byteLength(JSON.stringify(cs));const result=await pipeline(cs);return reply===undefined?result:reply as unknown[];};
const call=()=>GET(new Request(`https://marktmorgen.test/api/backup/files?source=blob&store=${store}`,{headers:{authorization:"Bearer "+secret}}));
function reset(){redis.clear();resetBlobWorld();process.env.BACKUP_FILES_ROUTE_SECRET=secret;commands=0;bytes=0;reply=undefined;}
async function main(){
 for(const bad of [null,[],["OK"],["OK",1,"extra"],["OK","1"],["OK",0],["OK",1.5],["?",1]]){
  reset();reply=bad;blobWorld.pages=[{blobs:[],hasMore:false}];const r=await call();const used=redis.run(["GET",key]);
  console.log("ADMISSION_UNKNOWN",JSON.stringify({bad,status:r.status,used,commands,bytes,list:blobWorld.listCalls.length,token:blobWorld.tokenCalls.length}));
  is("unknown ACK does not list "+JSON.stringify(bad),[r.status,blobWorld.listCalls.length,blobWorld.tokenCalls.length,used],[503,0,0,"1"]);
 }
 reset();redis.run(["SET",key,"40","EX",172800]);blobWorld.pages=[{blobs:[],hasMore:false}];const over=await call();is("daily ceiling before provider",[over.status,blobWorld.listCalls.length,blobWorld.tokenCalls.length,redis.run(["GET",key])],[429,0,0,"41"]);
 reset();blobWorld.pages=[{blobs:[],hasMore:false}];let r=await call();const empty=await r.json();is("confirmed empty consumes one count and no token",[r.status,empty.complete,empty.entries.length,redis.run(["GET",key]),blobWorld.listCalls.length,blobWorld.tokenCalls.length],[200,true,0,"1",1,0]);
 reset();blobWorld.pages=[{blobs:[{pathname:`stores/${store}/known.pdf`,size:7,etag:'"z"'}],hasMore:false}];r=await call();const one=await r.json();is("one object: paid page, one get-only token, one local signer",[r.status,one.entries.length,redis.run(["GET",key]),blobWorld.listCalls.length,blobWorld.tokenCalls.length,blobWorld.presignCalls.length,blobWorld.tokenCalls[0].operations],[200,1,"1",1,1,1,["get"]]);
 is("signed answer contains no signing credential",JSON.stringify(one).includes("client-signing-secret-synthetic"),false);
 reset();for(const source of ["r2","bunny"]){r=await GET(new Request(`https://marktmorgen.test/api/backup/files?source=${source}&store=${store}`,{headers:{authorization:"Bearer "+secret}}));is(source+" remains off before Redis/provider",[r.status,commands,blobWorld.listCalls.length],[503,0,0]);}
 done();
}
void main();
