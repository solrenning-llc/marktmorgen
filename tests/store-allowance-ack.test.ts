import assert from "node:assert/strict";
import {allowancesUsedStrict, allowanceUsed, allowanceUsedExact, giveAllowanceIn, takeAllowance} from "@/lib/store-allowance";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
import {done,is,part} from "./check";
let visited=0,sequence=0;
const cases:[string,()=>unknown][]=[
 ["lost",()=>[]],["short",()=>["OK"]],["string count",()=>["OK","1"]],["boolean count",()=>["OK",true]],
 ["unknown SET",()=>[true,1]],["infinite",()=>["OK",Infinity]],["fractional",()=>["OK",1.5]],["zero",()=>["OK",0]],
 ["extra member",()=>["OK",1,1]],["inherited",()=>{const a=new Array(2);a[0]="OK";Object.setPrototypeOf(a,{1:1});return a;}],
 ["accessor",()=>{const a=["OK",1];Object.defineProperty(a,"1",{get(){visited++;return 1;}});return a;}],
 ["extra property",()=>Object.assign(["OK",1],{extra:true})],
 ["symbol",()=>Object.assign(["OK",1],{[Symbol("unknown")]:true})],
];
async function main(){
 part("Actual paid resource allowance requires confirmed finite consumption");
 const pipeline=redis.pipeline;
 for(const [name,shape]of cases){
  const owner={sid:String(++sequence).padStart(32,"0"),handle:"counterack"+sequence,statsId:null,tier:"creator" as const,cycle:"month" as const,subscriptionId:"sub_CounterAck0001",subscriptionActive:true,trialEnds:0,planEndedAt:"",period:paidPeriod()};
  let calls=0,key="",commands=0;
  redis.pipeline=async input=>{
   calls++;commands+=input.length;
   const reply=await pipeline(input);
   if(input.some(c=>c[0]==="INCRBY")){key=String(input[0][1]);return shape() as never;}
   return reply;
  };
  let result;try{result=await takeAllowance(owner,"studio");}finally{redis.pipeline=pipeline;}
  is("uncertain reply refuses: "+name,result.ok,false);
  is("exactly one two-command admission: "+name,[calls,commands],[1,2]);
  is("committed use retained: "+name,await pipeline([["GET",key]]),["1"]);
  const next=await takeAllowance(owner,"studio");
  assert.equal(next.ok,true,"later confirmed use recovers without releasing uncertain use: "+name);
  is("next confirmation counts both uses: "+name,await pipeline([["GET",key]]),["2"]);
 }
 is("no getter invoked",visited,0);
 part("A displayed or spending count is exact, or unavailable");
 const owner={sid:"12345678901234567890123456789012",handle:"readcounter",statsId:null,tier:"creator" as const,cycle:"month" as const,subscriptionId:"sub_CounterRead0001",subscriptionActive:true,trialEnds:0,planEndedAt:"",period:paidPeriod()};
 const malformed:[string,()=>unknown][]=[
  // A whole-number reply is a count by main's design (b4bde83c5, tests/allowance-used-unknown.test.ts control), so it is checked below as confirmed, not here.
  ["empty",()=>[""]],["whitespace",()=>[" "]],
  ["leading zero",()=>["01"]],["signed",()=>["+1"]],["exponent",()=>["1e2"]],
  ["fraction",()=>["1.5"]],["negative",()=>["-1"]],["unsafe",()=>["9007199254740992"]],
  ["missing",()=>[]],["extra",()=>["1",null]],["extra field",()=>Object.assign(["1"],{other:1})],
  ["symbol",()=>Object.assign(["1"],{[Symbol("extra")]:1})],
  ["inherited",()=>{const a=new Array(1);Object.setPrototypeOf(a,{0:"1"});return a;}],
  ["getter",()=>{const a=["1"];Object.defineProperty(a,"0",{get(){visited++;return "1";}});return a;}],
  ["proxy",()=>new Proxy(["1"],{get(t,p,r){if(p!=="then")visited++;return Reflect.get(t,p,r);}})],
 ];
 for(const [name,shape] of malformed){
  let calls=0;
  redis.pipeline=async()=>{calls++;return shape() as never;};
  try{
   is("strict view unavailable: "+name,await allowancesUsedStrict(owner,["studio"]),null);
   // Main's design (rule 24): the exact single read answers null for an unknown count, never a number.
   is("single count is unknown, not a number: "+name,await allowanceUsedExact(owner,"studio"),null);
   is("no retry or replacement reading: "+name,calls,2);
  }finally{redis.pipeline=pipeline;}
 }
 for(const [raw,want] of [[null,0],["0",0],["123",123],[0,0],[7,7]] as const){
  redis.pipeline=async()=>[raw];
  try{
   is("confirmed count: "+String(raw),await allowanceUsed(owner,"studio"),want);
   is("confirmed strict count: "+String(raw),(await allowancesUsedStrict(owner,["studio"]))?.[0]?.used,want);
  }finally{redis.pipeline=pipeline;}
 }
 redis.pipeline=async()=>{throw Error("synthetic read unavailable");};
 try{is("transport failure is unknown, not a number",await allowanceUsedExact(owner,"studio"),null);}finally{redis.pipeline=pipeline;}
 part("Only an exact signed decrement authorizes the existing repair");
 for(const [name,shape] of [["coerced negative",()=>["-1"]],["extra decrement",()=>[-1,0]],["too negative",()=>[-4]],["getter decrement",()=>{const a=[-1];Object.defineProperty(a,"0",{get(){visited++;return -1;}});return a;}]] as [string,()=>unknown][]){
  let calls=0;redis.pipeline=async()=>{calls++;return shape() as never;};
  try{const now=Date.now();await giveAllowanceIn(owner,"studio",3,new Date(now).toISOString().slice(0,7),now);is("no repair from unknown: "+name,calls,1);}finally{redis.pipeline=pipeline;}
 }
 let repairs=0;redis.pipeline=async input=>{repairs++;return input.length===1?[-1]:[0,1];};
 try{const now=Date.now();await giveAllowanceIn(owner,"studio",3,new Date(now).toISOString().slice(0,7),now);is("confirmed negative repair retained",repairs,2);}finally{redis.pipeline=pipeline;}
 is("no read or decrement getter executed",visited,0);
 done();
}
main().catch(e=>{console.error(e);process.exit(1);});
