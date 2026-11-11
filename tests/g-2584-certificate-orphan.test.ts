/** G: exact real certificate eraser; incomplete synthetic GETDEL replies. */
import { certificatesFor, forgetCertificatesPerson, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
const course={id:"d".repeat(32),certificate:true,startsAt:null,modules:[{id:"module000001",title:"One",dripDays:0,lessons:[{id:"lesson000001",title:"One",preview:false,video:null,files:[],link:null,hasBody:false,quiz:null}]}]} as Course;
async function make(email:string){return issueCertificate({store:"storekey01",productId:"prod01",course,title:"Bookkeeping",creator:"Night School",email,who:emailKey(email),name:"Private Person",room:ROOM});}
async function main(){
 const real=redis.pipeline.bind(redis);
 for(const reply of [[],[undefined]]){
  redis.clear();
  const made=await make("person@example.com");if(!made.ok)throw Error("control: issue failed");
  const id=made.certificate.id;
  redis.pipeline=(async(commands:(string|number)[][])=>commands.some(c=>c[0]==="GETDEL"&&c[1]===`nl:cert:${id}`)?reply:real(commands)) as typeof redis.pipeline;
  let refused=false,result:unknown;
  try{result=await forgetCertificatesPerson([course.id],"person@example.com",ROOM);}catch{refused=true;}
  finally{redis.pipeline=real as typeof redis.pipeline;}
  console.log("Partial GETDEL result",reply,result);
  is("control: underlying private certificate survives "+JSON.stringify(reply),(await readCertificate(id))?.email,"person@example.com");
  is("unknown deletion must not report a removed certificate "+JSON.stringify(reply),refused,true);
  is("unconfirmed record must remain discoverable for retry "+JSON.stringify(reply),(await certificatesFor(course.id))?.total,1);
  const retry=await forgetCertificatesPerson([course.id],"person@example.com",ROOM);
  is("retry can still erase the private record "+JSON.stringify(reply),[retry,await readCertificate(id)],[1,null]);
 }
 redis.clear();
 const made=await make("positive@example.com");if(!made.ok)throw Error("control: positive issue failed");
 is("positive exact deletion still removes the certificate",[await forgetCertificatesPerson([course.id],"positive@example.com",ROOM),await readCertificate(made.certificate.id)],[1,null]);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
