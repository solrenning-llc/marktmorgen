/** Import conflict regression: new writes keep main's counted origin and erasure returns exactly their room. */
import {forgetContactPerson,importContacts,importContactRows,leadsKey,upsertContact} from "@/lib/contacts";
import {dataUsed} from "@/lib/store-data";
import {store as redis} from "./redis-stub";
import {ROOM} from "./data-room";
import {done,is,part} from "./check";
async function main(){
 process.env.UPSTASH_REDIS_REST_URL??="http://stub";
 for(const mode of ["paste","file"] as const){
  redis.clear();const list="x4-import-origin-"+mode;const target=mode+"@example.com";
  await upsertContact(list,"resident@example.com",{agreed:true,explicit:true,source:"free"},ROOM);
  const baseline=(await dataUsed(ROOM))!.used;
  part(mode+": main origin survives atomic import and erasure");
  if(mode==="paste")is("one confirmed paste",(await importContacts(list,[target],ROOM)).added,1);
  else is("one confirmed file row",await importContactRows(list,[{email:target,name:"Synthetic",tags:[]}],ROOM),["added"]);
  const raw=JSON.parse(String(redis.run(["HGET",leadsKey(list),target])));
  is("counted in contacts slot",raw.r,"c");
  is("its growth was charged",(await dataUsed(ROOM))!.used>baseline,true);
  is("one deletion",await forgetContactPerson(list,target,ROOM),1);
  is("exact growth returned",(await dataUsed(ROOM))!.used,baseline);
  is("resident retained",typeof redis.run(["HGET",leadsKey(list),"resident@example.com"]),"string");
  is("repeat deletion returns nothing",await forgetContactPerson(list,target,ROOM),0);
  is("no second credit",(await dataUsed(ROOM))!.used,baseline);
 }
 done();
}
main().catch(e=>{console.error(e);process.exit(1)});
