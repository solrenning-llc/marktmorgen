// The production route keeps R2 OFF; this tests only its dormant parser.
import {backupFilesR2Config,listR2Page} from "@/lib/backup-files-r2";
import {done,is} from "../../../tests/check";
const store="0123456789abcdef0123456789abcdef",prefix=`vault/${store}/`;
const config=backupFilesR2Config({R2_ACCOUNT_ID:store,R2_BUCKET:"synthetic-bucket",BACKUP_FILES_R2_READ_KEY_ID:"synthetic-read-id-0123456789",BACKUP_FILES_R2_READ_SECRET:"synthetic-read-secret-01234567890123456789"})!;
const empty='<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
let body=empty,calls=0;
globalThis.fetch=(async()=>{calls++;return new Response(body,{status:200});}) as typeof fetch;
async function main(){
 is("healthy empty listing",await listR2Page(config,prefix,null),{objects:[],next:null});
 for(const text of ['not XML'+empty,'<Unclosed>'+empty,empty.replace('<IsTruncated>','<Unclosed><IsTruncated>')]){
  body=text;let threw=false;let answer:unknown;try{answer=await listR2Page(config,prefix,null);}catch{threw=true;}
  console.log("DORMANT_R2_XML",JSON.stringify({body,textBytes:Buffer.byteLength(text),threw,answer}));is("malformed XML must stay unknown",threw,true);
 }
 is("one bounded mock GET per attempt",calls,4);done();
}
void main();
