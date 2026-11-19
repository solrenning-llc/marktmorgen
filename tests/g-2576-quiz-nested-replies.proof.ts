import {forgetQuizPerson,markPassed} from '@/lib/quiz';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {done,is} from './check';
async function main(){
const course='q'.repeat(32),lesson='lesson000001',who='g-private-learner';
const real=redis.pipeline.bind(redis);
for(const kind of ['holes','getter']){
redis.clear();await markPassed(course,who,lesson,ROOM);
let reads=0;const values:unknown[]=new Array(2);
if(kind==='getter'){Object.defineProperty(values,0,{get(){reads++;return null;}});values[1]=null;}
let refused=false,result:unknown;
redis.pipeline=(async commands=>commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:set-and-values-take:'))?[[[],values,0]]:real(commands)) as typeof redis.pipeline;
try{result=await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM);}catch{refused=true;}finally{redis.pipeline=real;}
console.log(kind,{result,refused,reads});
is(`${kind}: pass still stored`,(await real([['SISMEMBER',`nl:course:${course}:passed:${who}`,lesson]]))[0],1);
is(`${kind}: unconfirmed nested values must refuse`,refused,true);
is(`${kind}: accessors never run`,reads,0);
is(`${kind}: normal retry erases pass`,await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM),1);
}
redis.clear();is('exact empty quiz reply remains valid',await forgetQuizPerson([{courseId:course,lessonIds:[lesson]}],who,ROOM),0);done();}
main().catch(e=>{console.error(e);process.exitCode=1;});
