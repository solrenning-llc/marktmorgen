/** Independent C4-0700 condition (1) proof; actual route/auth/door/catalog, existing in-memory provider fixture. */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { notePictureDoor } from "@/lib/picture-door";
import { POST } from "@/app/api/store/image/route";
import { TONE_PATTERN } from "@/lib/product-image";
import { files } from "../../tests/failure-cleanup-world";
import { store as redis } from "../../tests/redis-stub";
import { done, is, part } from "../../tests/check";

async function main() {
  redis.clear();files.clear();
  const owner="tone.review@example.com";
  await claimHandle(owner,"tonereview","Tone Review","");await ensureStatsId(owner);
  const session=await openSession(owner),folder=await imageFolder(owner);
  const jpeg=new Uint8Array([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0]);
  const cases=[{name:"absent",tone:undefined,valid:true},{name:"exact",tone:"#336699",valid:true},{name:"short",tone:"#369",valid:false},{name:"uppercase",tone:"#ABCDEF",valid:false},{name:"CSS syntax",tone:"red; color:white",valid:false}];
  let n=0;
  part("C4-0700: an invalid supplied colour refuses attachment without writing");
  for(const c of cases){
    const made=await addProduct(owner,"Synthetic picture "+c.name,"","19",null);if(!made.ok)throw Error("fixture");
    const path=`images/${folder}/${(++n).toString(16).padStart(32,"0")}.jpg`;
    await notePictureDoor(path);files.set(path,{bytes:jpeg,contentType:"image/jpeg",at:Date.now()+1});
    const request=new NextRequest("https://marktmorgen.com/api/store/image",{method:"POST",headers:{"content-type":"application/json",cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify({action:"attach",id:made.product.id,path,width:1200,height:800,alt:"Synthetic cover",...(c.tone===undefined?{}:{tone:c.tone})})});
    const response=await POST(request),answer=await response.json();
    const image=(await readListing((await storeForEmail(owner))!,made.product.id))?.image;
    console.log("ATTACH_OBSERVATION",JSON.stringify({case:c.name,status:response.status,answer,pathWritten:image?.path===path,tone:image?.tone??null}));
    is(c.name+": success only for absent/exact colour",response.status,c.valid?200:400);
    is(c.name+": invalid colour leaves the product picture untouched",image?.path===path,c.valid);
    if(c.valid)is(c.name+": optional colour preserved exactly",image?.tone,c.tone);
  }
  is("a trailing newline is rejected",TONE_PATTERN.test("#123456\n"),false);
  done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
