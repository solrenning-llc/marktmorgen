// Codex G's proof on #2576 (review 5809834671), transcribed from the review's code block with its assertions unchanged; its SHA256 does not match the af05123b… the review gives, likely whitespace in the transcription.
import {forgetCommunityPerson} from '@/lib/community-erasure';
import {traceKey} from '@/lib/community-trace';
import {dataUsed,noteData} from '@/lib/store-data';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
import {done,is} from './check';
let calls=0,commands=0,fetches=0;
globalThis.fetch=async()=>{fetches++;throw Error('No external request');};
async function main(){
 redis.clear();const key=traceKey('c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c1','whoabc'),other=traceKey('c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c1','otherabc');
 await redis.pipeline([['SADD',key,'own'],['SADD',other,'retained']]);
 await noteData(ROOM,[{slot:'cm:m',bytes:9600}]);
 const before=await dataUsed(ROOM),pipe=redis.pipeline.bind(redis);
 redis.pipeline=async cs=>{commands+=cs.length;if(commands>200)throw Error('Synthetic command ceiling');if(cs.length===1&&cs[0][0]==='EVAL'&&cs[0][3]===key){calls++;return[Number.MAX_SAFE_INTEGER+1];}return pipe(cs);};
 let result;try{result=await forgetCommunityPerson('c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c1','whoabc','member@example.test',[],ROOM).then(n=>'done '+n,e=>e.name);}finally{redis.pipeline=pipe;}
 const after=await dataUsed(ROOM),kept=await redis.pipeline([['SCARD',key],['SCARD',other]]);
 is('one injected response',calls,1);is('unsafe count is unknown',result,'UnknownReply');
 is('room stays exactly counted',after,before);is('retained trace sets exist',kept,[1,1]);is('no external request',fetches,0);
 console.log('G_UNSAFE_ROOM',JSON.stringify({before,after,result,kept,commands}));done();
}
void main();

