// A dormant guard omission, not activation or a live compromise.
import {GET} from "@/app/api/backup/files/route";
import {backupFilesRouteSecret} from "@/lib/backup-files-source";
import {blobWorld,resetBlobWorld} from "../../../tests/backup-files-world";
import {done,is} from "../../../tests/check";
const id="0123456789abcdef0123456789abcdef",store="fedcba9876543210fedcba9876543210";
async function main(){
 is("existing production R2 access id is refused",backupFilesRouteSecret({BACKUP_FILES_ROUTE_SECRET:id,R2_ACCESS_KEY_ID:id}),null);
 is("new backup read access id must also be refused",backupFilesRouteSecret({BACKUP_FILES_ROUTE_SECRET:id,BACKUP_FILES_R2_READ_KEY_ID:id}),null);
 resetBlobWorld();process.env.BACKUP_FILES_ROUTE_SECRET=id;process.env.BACKUP_FILES_R2_READ_KEY_ID=id;blobWorld.pages=[{blobs:[],hasMore:false}];const r=await GET(new Request(`https://marktmorgen.test/api/backup/files?source=blob&store=${store}`,{headers:{authorization:"Bearer "+id}}));
 console.log("DORMANT_SECRET_REUSE",JSON.stringify({status:r.status,list:blobWorld.listCalls.length,token:blobWorld.tokenCalls.length}));
 is("under only a synthetic review, reused read id cannot authenticate",[r.status,blobWorld.listCalls.length],[404,0]);done();
}
void main();
