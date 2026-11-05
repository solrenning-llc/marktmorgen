/** Independent corrective review: every fixture comment is created by the real writer and paid data-room admission. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {addComment} from '@/lib/lesson-comments';
import {CREATOR_AUTHOR,MAX_LESSON_THREADS} from '@/lib/lesson-comments-rules';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {UNIT_COST,COMMAND,COST_LINES} from './plan-cost-registry';
async function main(){
 redis.clear();const course='e'.repeat(32),lesson='lessonone001',hash=`nl:lc:${course}:c`,ids:string[]=[],rows:string[]=[];
 const size=1500;assert.ok(size<MAX_LESSON_THREADS*4);
 for(let i=0;i<size;i++){const result=await addComment({room:ROOM,courseId:course,lessonId:lesson,by:CREATOR_AUTHOR,text:'Paid retained comment '+i,now:100+i});assert.ok(result.ok);ids.push(result.comment.id);rows.push(String(redis.run(['HGET',hash,result.comment.id])));}
 writeFileSync('.review-output/lesson-delete-cost-fixture.json',JSON.stringify({course,lesson,ids,rows,studioUnit:UNIT_COST.studio,commandUnit:COMMAND,scaleStudioMonth:COST_LINES.find(line=>line.id==="studio")!.monthlyUsd("scale")}));
 console.log('PASS real writer admitted '+size+' records; studio unit '+UNIT_COST.studio);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
