/** G: a partial erasure frees only confirmed course room, preserving the unknown course and another course. */
import {forgetQuizPerson,markPassed} from '@/lib/quiz';
import {dataUsed} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {done,is} from './check';
async function used(){const n=await dataUsed(ROOM);if(!n)throw Error('unknown room');return n.used;}
async function main(){
 redis.clear();const real=redis.pipeline.bind(redis),lesson='lesson000001',who='g-mixed-private';
 const [a,b,c]=['a','b','c'].map(v=>v.repeat(32));
 for(const id of [a,b,c])await markPassed(id,who,lesson,ROOM);
 const before=await used(),one=before/3;
 let hit=0,refused=false;
 redis.pipeline=async commands=>{
  if(commands.length===2&&commands.every(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:set-and-values-take:'))){
   hit++;const first=await real([commands[0]]);
   return[first[0],[[lesson],[null,null],0]];
  }
  return real(commands);
 };
 const courses=[a,b].map(courseId=>({courseId,lessonIds:[lesson]}));
 try{await forgetQuizPerson(courses,who,ROOM);}catch{refused=true;}finally{redis.pipeline=real;}
 const present=async(id:string)=>(await real([['SISMEMBER',`nl:course:${id}:passed:${who}`,lesson]]))[0];
 is('actual mixed pipeline reached',hit,1);
 is('unknown second course propagates incomplete',refused,true);
 is('first actual course was deleted',await present(a),0);
 is('unknown second course remains',await present(b),1);
 is('unrelated third course remains',await present(c),1);
 is('only confirmed course room is released',await used(),before-one);
 is('healthy retry removes only still-present target course',await forgetQuizPerson(courses,who,ROOM),1);
 is('unrelated room remains after recovery',await used(),one);
 is('another retry is idempotent',await forgetQuizPerson(courses,who,ROOM),0);
 is('unrelated course can be deleted normally',await forgetQuizPerson([{courseId:c,lessonIds:[lesson]}],who,ROOM),1);
 is('all actual occupied room is released once',await used(),0);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
