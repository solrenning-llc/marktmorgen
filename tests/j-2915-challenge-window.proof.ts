/**
 * Independent review of the inert challenge-window classifier at
 * 149a6fdf0c2808f525601cb5588674ebcf1a1abd. No community feature is enabled.
 * A BigInt ordering oracle checks the supplied instants without duration sums.
 */
import { challengeWindowState } from "@/lib/community-challenge-rules";
import { done, is, part } from "./check";
const edge=8_640_000_000_000_000;
const instants=[-edge,-edge+1,-edge+2,-2,-1,0,1,2,edge-2,edge-1,edge];
function oracle(start:number,end:number,now:number):string {
  const [s,e,n]=[BigInt(start),BigInt(end),BigInt(now)];
  if(e<=s)return "invalid";
  const membership=n>=s&&n<e;
  return membership?"active":n>=e?"ended":"scheduled";
}
part("Exhaustive independent ordering matrix");
const mismatches:unknown[]=[];
let vectors=0;
for(const start of instants)for(const end of instants)for(const now of instants){
  vectors++;const actual=challengeWindowState(start,end,now),expected=oracle(start,end,now);
  if(actual!==expected)mismatches.push({start,end,now,actual,expected});
}
is("all 1331 ordered triples match the BigInt membership oracle",{vectors,mismatches},{vectors:1331,mismatches:[]});
for(const [label,start,end,now,expected] of [
  ["earliest inclusive start",-edge,-edge+1,-edge,"active"],
  ["earliest exclusive end",-edge,-edge+1,-edge+1,"ended"],
  ["latest inclusive start",edge-1,edge,edge-1,"active"],
  ["latest exclusive end",edge-1,edge,edge,"ended"],
  ["negative and positive zero",-0,1,+0,"active"],
] as const)is(label,challengeWindowState(start,end,now),expected);

part("Malformed primitives remain invalid at every argument position");
const invalid:unknown[]=[undefined,null,"0","1e3","2026-11-06",true,false,BigInt(0),Symbol("time"),NaN,Infinity,-Infinity,
  .25,-.25,edge+1,-edge-1,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER,Number.MAX_VALUE,Number.MIN_VALUE,
  [],[0],{},new Date(0),Object(0)];
for(const position of [0,1,2]){
  const failures:number[]=[];
  invalid.forEach((value,index)=>{
    const args:unknown[]=[0,2,1];args[position]=value;
    if(Reflect.apply(challengeWindowState,undefined,args)!=="invalid")failures.push(index);
  });
  is(`all ${invalid.length} malformed inputs at position ${position} are rejected`,failures,[]);
}

part("No coercion, reflection or ambient-clock dependency");
let hooks=0;
const object=Object.freeze({
  get valueOf(){hooks++;throw new Error("valueOf getter must not execute");},
  [Symbol.toPrimitive](){hooks++;throw new Error("coercion must not execute");},
});
is("conversion hooks are never used",[challengeWindowState(object,2,1),challengeWindowState(0,object,1),challengeWindowState(0,2,object)],["invalid","invalid","invalid"]);
is("zero conversion/property hooks ran",hooks,0);
const revoked=Proxy.revocable({},{});revoked.revoke();
is("revoked proxies are rejected without reflection",[challengeWindowState(revoked.proxy,2,1),challengeWindowState(0,revoked.proxy,1),challengeWindowState(0,2,revoked.proxy)],["invalid","invalid","invalid"]);
is("safe integers outside the Date range remain invalid",[challengeWindowState(Number.MIN_SAFE_INTEGER,0,-1),challengeWindowState(0,Number.MAX_SAFE_INTEGER,1)],["invalid","invalid"]);
is("omitted supplied now never invents an ambient instant",Reflect.apply(challengeWindowState,undefined,[0,2]),"invalid");
const oldNow=Date.now;let clockReads=0;
Date.now=()=>{clockReads++;throw new Error("ambient clock must not run");};
let states:string[];
try{states=[challengeWindowState(100,200,99),challengeWindowState(100,200,100),challengeWindowState(100,200,200)];}
finally{Date.now=oldNow;}
is("the explicit instants determine state even with a forbidden clock",states,["scheduled","active","ended"]);
is("no ambient clock was consulted",clockReads,0);

part("Translation invariance without additive clock arithmetic");
const shifted:string[]=[];
for(const offset of [-edge+4,0,edge-4])for(const now of [-1,0,1,2,3])shifted.push(challengeWindowState(offset,offset+2,offset+now));
is("three widely separated epochs have the same supplied-time states",shifted,Array(3).fill(["scheduled","active","active","ended","ended"]).flat());
is("a duration wider than MAX_SAFE_INTEGER does not overflow classification",[challengeWindowState(-edge,edge,-edge),challengeWindowState(-edge,edge,0),challengeWindowState(-edge,edge,edge)],["active","active","ended"]);
console.log("MATRIX",JSON.stringify({orderedTriples:vectors,invalidVectors:invalid.length*3,translationVectors:shifted.length}));
done();
