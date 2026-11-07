/** Independent focal checks: keep a young orphan due, recover an old one once, and refuse unreadable job evidence. */
import { createHash } from "node:crypto";
import { runEventQueue } from "@/lib/community-event-mail";
import { db, event, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";
type Command = (string | number)[];
const original = db.pipeline.bind(db);
const due = `${store.community!.id}|${store.handle}|${event.id}|24|${event.start}`;
const id = createHash("sha256").update(`${store.community!.id}|${event.id}|24|${event.start}`).digest("hex").slice(0,24);
const key = `nl:cm:evmail:${id}`, mark = `${key}:made`;
const run = () => runEventQueue(async () => store, Date.now() + 10_000, {mail:true});
const state = () => [sent.length, db.run(["ZCARD","nl:cm:evq"])];
const seed = (age: number) => {reset(); db.run(["ZADD","nl:cm:evq",1,due]); db.run(["SET",mark,`${Date.now()-age}.123456789`,"EX",2592000]);};
async function main(): Promise<void> {
  part("Young versus orphaned mark");
  seed(0);
  await run();
  is("young mark sends nothing and keeps the reminder due",state(),[0,1]);
  const realNow=Date.now;
  Date.now=()=>realNow()+11*60_000;
  try {await run();is("after the window the reminder is sent once",state(),[1,0]);await run();is("another sweep does not send twice",state(),[1,0]);}
  finally {Date.now=realNow;}

  part("Two sweeps see the same orphan");
  seed(11*60_000);
  let readers=0,open!:()=>void;
  const barrier=new Promise<void>(resolve=>{open=resolve;});
  db.pipeline=async(commands:Command[])=>{
    const result=await original(commands);
    if(commands.length===2&&commands[0][0]==="GET"&&commands[0][1]===mark){readers++;if(readers===2)open();await barrier;}
    return result;
  };
  try {await Promise.all([run(),run()]);}finally{db.pipeline=original;}
  is("both saw the orphan before either compare-delete",readers,2);
  is("only one send survives concurrent takeover",state(),[1,0]);

  part("Unreadable send evidence cannot mean made");
  for(const raw of ["{cut",JSON.stringify({id:"invalid"})]) {
    seed(11*60_000);
    db.pipeline=async(commands:Command[])=>{
      const result=await original(commands);
      if(commands.length===2&&commands[0][0]==="GET"&&commands[0][1]===mark)return[result[0],raw];
      return result;
    };
    try {await run();}finally{db.pipeline=original;}
    is(`unreadable ${raw} keeps due without sending`,state(),[0,1]);
    is("the underlying job really is absent",db.run(["GET",key]),null);
    await run();
    is("healthy retry creates the retained reminder once",state(),[1,0]);
  }
  done();
}
void main();
