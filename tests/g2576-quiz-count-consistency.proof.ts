/** G residual: the receipt's deletion count must agree with the set/value contents returned by the same atomic script. */
import {forgetQuizPerson,markPassed} from '@/lib/quiz';
import {dataUsed} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {done,is} from './check';
async function used(){const n=await dataUsed(ROOM);if(!n)throw Error('room unavailable');return n.used;}
async function main(){
 const course='q'.repeat(32),lesson='lesson000001',who='g-private-learner';
 const real=redis.pipeline.bind(redis);
 for(const gone of [0,2,99,Number.MAX_SAFE_INTEGER+1]){
  redis.clear();await markPassed(course,who,lesson,ROOM);
  const before=await used();let hit=0,refused=false,result:unknown;
  redis.pipeline=async commands=>{
   if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:set-and-values-take:'))){hit++;return [[[lesson],[null,null],gone]];}
   return real(commands);
  };
  try{result=await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM);}catch{refused=true;}finally{redis.pipeline=real;}
  const after=await used();
  console.log('G_QUIZ_COUNT',JSON.stringify({gone,hit,refused,result,before,after}));
  is(`${gone}: exact transport boundary reached`,hit,1);
  is(`${gone}: personal pass remains before healthy retry`,(await real([['SISMEMBER',`nl:course:${course}:passed:${who}`,lesson]]))[0],1);
  is(`${gone}: contradictory or unsafe count is unknown`,refused,true);
  is(`${gone}: unconfirmed deletion preserves occupied room`,after,before);
  is(`${gone}: healthy retry erases actual pass`,await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM),1);
 }
 redis.clear();await markPassed(course,who,lesson,ROOM);
 is('known actual deletion succeeds',await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM),1);
 is('known deletion frees its actual room',await used(),0);
 is('confirmed absence remains zero',await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM),0);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
