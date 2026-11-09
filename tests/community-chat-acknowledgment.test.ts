import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/chat/route";
import { parseChatSetting, refusalWords, room, say } from "@/lib/community-chat";
import { communityWords, roomWords } from "@/lib/buyer-words/community";
import { freshConfig, saveConfig } from "@/lib/community";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const id="a".repeat(32), who="b".repeat(32), open=parseChatSetting({on:true}), slow=parseChatSetting({on:true,slow:60});
  const original=redis.pipeline.bind(redis);
  let operation="", answer:unknown[]=[], applied=false, throws=false, calls:string[]=[];
  redis.pipeline=async(commands)=>{
    calls.push(String(commands[0]?.[0]));
    if(commands[0]?.[0]===operation){if(applied)await original(commands);if(throws)throw Error("synthetic lost reply");return answer as never;}
    return original(commands);
  };
  async function attempt(op:string,reply:unknown[],apply=false,cooldown=false,fail=false){
    redis.clear();operation=op;answer=reply;applied=apply;throws=fail;calls=[];
    try{return await say(id,cooldown?slow:open,who,false,"A synthetic message");}catch{return {threw:true};}
  }
  try{
    part("The cooldown must be confirmed before sequencing a message");
    for(const reply of [[],[undefined],[false],[1],["NO"],["OK","extra"]]){
      is(`unconfirmed cooldown ${String(reply)}`, [await attempt("SET",reply,false,true),calls], [{ok:false,reason:"unknown"},["SET"]]);
    }
    is("a lost reply after taking the real cooldown still stops before INCR",[await attempt("SET",[],true,true),calls],[{ok:false,reason:"unknown"},["SET"]]);
    operation="";
    const retry=await say(id,slow,who,false,"Still waiting");
    is("the already-taken cooldown remains enforced on an ordinary later attempt",[retry.ok,retry.ok?null:retry.reason,(await room(id)).messages.length],[false,"slow",0]);
    part("A sequence must be a confirmed positive integer");
    for(const reply of [[],[null],[true],["1"],[0],[-1],[1.5],[Infinity],[Number.MAX_SAFE_INTEGER+1],[1,2]]){
      is(`unconfirmed sequence ${String(reply)}`, [await attempt("INCR",reply),calls], [{ok:false,reason:"unknown"},["INCR"]]);
    }
    part("A write batch must confirm the inserted message and bounded trim");
    for(const reply of [[],[1],[0,0],[1,null],[1,"0"],[1,-1],[1,0,0],[null,0]]){
      const result=await attempt("ZADD",reply,true);
      is(`unconfirmed applied write ${String(reply)} is never success`, result, {ok:false,reason:"unknown"});
      is("one write attempt only, no automatic retry", calls.filter(c=>c==="ZADD").length,1);
      operation="";
      is("the ordinary room read recovers the message that actually arrived", (await room(id)).messages.map(m=>m.text),["A synthetic message"]);
    }
    is("a confirmed write retains the existing success", (await attempt("ZADD",[1,0],true) as {ok?:boolean}).ok,true);
    is("a confirmed positive trim is also accepted", (await attempt("ZADD",[1,2],true) as {ok?:boolean}).ok,true);
    is("a transport exception after applying the write is explicitly unconfirmed",await attempt("ZADD",[],true,false,true),{ok:false,reason:"unknown"});
    is("a transport exception never retries the write",calls.filter(c=>c==="ZADD").length,1);
    operation="";throws=false;
    is("a normal read recovers a message whose transport response was lost",(await room(id)).messages.length,1);
    redis.clear();await original([["SET",`nl:cm:${id}:chs:${who}`,"1","EX",60]]);
    operation="TTL";answer=[];applied=false;calls=[];
    is("an unconfirmed wait never claims a known number of seconds", await say(id,slow,who,false,"Wait test"),{ok:false,reason:"unknown"});
    is("no sequence or message after an unconfirmed wait", calls,["SET","TTL"]);
    answer=[7];calls=[];
    is("the confirmed cooldown keeps the actual wait", await say(id,slow,who,false,"Wait test"),{ok:false,reason:"slow",wait:7});
  }finally{redis.pipeline=original;}

  part("Uncertainty stays visible in all existing store languages");
  const expected={en:"We could not confirm this message. Check the room before sending it again.",es:"No pudimos confirmar este mensaje. Revisa la sala antes de volver a enviarlo.",fr:"Nous n’avons pas pu confirmer ce message. Consultez le salon avant de l’envoyer à nouveau.",de:"Wir konnten diese Nachricht nicht bestätigen. Prüfen Sie den Chat, bevor Sie sie erneut senden.",it:"Non è stato possibile confermare questo messaggio. Controlla la chat prima di inviarlo di nuovo.",nl:"We konden dit bericht niet bevestigen. Controleer de chat voordat je het opnieuw verstuurt.",pt:"Não foi possível confirmar esta mensagem. Confira a sala antes de enviá-la novamente."};
  for(const [language,text]of Object.entries(expected)){
    is(`${language}: the actual room words never claim a lost-ACK message was not sent`,roomWords(language,"en-US",{live:5,idle:30,away:20,kept:500}).refusals.unknown,text);
    is(`${language}: the shared words agree`,communityWords(language).refusals.unknown,text);
  }
  is("the library fallback has the same honest wording",refusalWords("unknown",60),expected.en);

  part("The real posting route never returns a phantom confirmed message");
  redis.clear();const owner="chat-owner@example.com";
  await claimHandle(owner,"chatproof","Chat proof","");await ensureStatsId(owner);
  await setSubscription(owner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0} as never);
  await setCommunity(owner,true);const store=(await storeForEmail(owner))!;
  await saveConfig(store.community!.id,{...freshConfig(store.name),chat:open});
  const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
  let inserted=0;
  redis.pipeline=async(commands)=>{const reply=await original(commands);if(commands[0]?.[0]==="ZADD"&&String(commands[0][1]).endsWith(":ch")){inserted++;return [] as never;}return reply;};
  try{
    const response=await POST(new NextRequest("https://marktmorgen.com/api/store/community/chat",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({handle:store.handle,action:"say",text:"Route message"})}));
    const body=await response.json();
    is("lost write reply is an explicit unavailable response",[response.status,body],[503,{ok:false,error:"unknown"}]);
    is("only one actual insertion attempt",inserted,1);
    is("the real room can recover that message without repeating the send",(await room(store.community!.id)).messages.map(m=>m.text),["Route message"]);
  }finally{redis.pipeline=original;}
  done();
}
void main();
