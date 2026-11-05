import {freePlayerGrant as grant, FREE_PLAYER_MAX_SECONDS} from "@/lib/free-course-video-rules";
import {done,is} from "./check";
const known={limitSeconds:14400,percent:20,watchedAll:0,reservedFree:0,periodLeft:10000,videoSeconds:600};
for(const field of ['limitSeconds','watchedAll','reservedFree','periodLeft']) for(const bad of [null,NaN,Infinity,-Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
 is(field+' unknown '+String(bad),grant({...known,[field]:bad}),{kind:'unknown'});
}
is('period 119 seconds cannot authorize player',grant({...known,periodLeft:119}),{kind:'paused'});
is('period exactly 120 seconds authorizes exactly that',grant({...known,periodLeft:120}),{kind:'play',seconds:120,short:true});
is('known no free allowance is off',grant({...known,percent:0}),{kind:'off'});
let seed=123456;const rand=(n:number)=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
let valid=true, sequential=true;
for(let i=0;i<2000;i++) {
 const limit=1+rand(1000000),pct=rand(21),watched=rand(limit+1),reserved=rand(limit+1),period=rand(20000);
 const r=grant({limitSeconds:limit,percent:pct,watchedAll:watched,reservedFree:reserved,periodLeft:period,videoSeconds:i%2?null:1+rand(30000)});
 if(r.kind==='play')valid&&=Number.isSafeInteger(r.seconds)&&r.seconds>=120&&r.seconds<=FREE_PLAYER_MAX_SECONDS&&r.seconds<=period&&r.seconds+reserved<=Math.floor(limit*pct/100)&&r.seconds+reserved+watched<=limit;
 let held=0;
 for(let n=0;n<40;n++) {
  const x=grant({limitSeconds:limit,percent:pct,watchedAll:0,reservedFree:held,periodLeft:period,videoSeconds:300});
  if(x.kind!=='play')break;held+=x.seconds;
 }
 sequential&&=held<=Math.floor(limit*pct/100)&&held<=limit;
}
is('2000 deterministic cases stay within every numeric bound',valid,true);
is('2000 sequential reservation simulations stay within grant budget',sequential,true);
done();
