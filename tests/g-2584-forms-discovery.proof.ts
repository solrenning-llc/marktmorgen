/** G: synthetic HVALS discovery failures must not become successful erasure. */
import {parseForm,type FormResponse} from '@/lib/forms';
import {writeForm,addResponse,forgetFormsPerson,readResponses} from '@/lib/form-store';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
import {done,is} from './check';
async function main(){
const stats='g'.repeat(16),email='private@example.com';
const form=parseForm({id:'exactform1',name:'Application',fields:[{id:'email1',type:'email',label:'Email',required:true}],offerList:false})!;
const answer:FormResponse={at:1,page:'/apply',answers:{email1:email},outcome:'',joined:false};
const real=redis.pipeline.bind(redis);
for(const [label,bad] of [['missing',[]],['undefined',[undefined]],['null',[null]],['wrong-type',[0]],['sparse',[new Array(1)]],['unparseable',[['broken JSON']]]] as const){
redis.clear();await writeForm(stats,form);await addResponse(stats,form.id,answer,ROOM);
let refused=false,result:unknown;
redis.pipeline=(async commands=>commands.some(c=>c[0]==='HVALS'&&c[1]===`nl:forms:${stats}`)?bad:real(commands)) as typeof redis.pipeline;
try{result=await forgetFormsPerson(stats,email,ROOM);}catch{refused=true;}finally{redis.pipeline=real;}
console.log(label,'returned',result,'refused',refused);
is(`${label}: underlying private response still exists`,(await readResponses(stats,form.id)).total,1);
is(`${label}: unknown discovery must fail erasure`,refused,true);
is(`${label}: restored discovery can erase`,await forgetFormsPerson(stats,email,ROOM),1);
}
redis.clear();is('confirmed empty form inventory is valid absence',await forgetFormsPerson(stats,email,ROOM),0);done();}
main().catch(e=>{console.error(e);process.exitCode=1;});
