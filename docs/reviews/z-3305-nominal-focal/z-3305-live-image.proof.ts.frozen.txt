/** Causal same-path recovery probe: existing consumed upload, real door/count/sweep, synthetic Blob set. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/upload/route";
import { takePicturePlace, noteCommunityUpload, takeCommunityUpload, picturesKept, sweepCommunityUploads } from "@/lib/community-files";
import { communityFolder } from "@/lib/community-image";
import { store as redis } from "../../../tests/redis-stub";
import { COMMUNITY_ID, MEMBER, files, deleted, tokens } from "../../../tests/community-upload-door-exact-world";
const real = redis.pipeline.bind(redis), folder = communityFolder(COMMUNITY_ID), day = 86_400_000;
test("MEDIUM regression: uncertain new door must not queue an already-consumed live picture for deletion", async () => {
  redis.clear(); files.clear(); deleted.length=0; tokens.length=0;
  const path = `community/${folder}/${"a".repeat(32)}.jpg`;
  assert.equal(await takePicturePlace(path,50),true);
  await noteCommunityUpload(path,MEMBER);files.add(path);
  assert.equal(await takeCommunityUpload(path,MEMBER),true);
  assert.equal((await real([["ZSCORE","nl:cimg:doors",path]]))[0],null,"used picture is no longer a disposable upload");
  const batches:(string|number)[][][]=[], oldError=console.error;console.error=()=>{};
  redis.pipeline=async commands=>{
    batches.push(commands);
    if(commands.length===2&&commands[0][0]==="SET"&&commands[1][0]==="ZADD")throw new Error("synthetic transport fails BEFORE noting the new door");
    return real(commands);
  };
  let response:Response;
  try{response=await POST(new NextRequest("https://marktmorgen.com/api/store/community/upload",{method:"POST",headers:{"content-type":"application/json",host:"marktmorgen.com"},body:JSON.stringify({pathname:path,clientPayload:JSON.stringify({handle:"doorshop"})})}));}
  finally{redis.pipeline=real;console.error=oldError;}
  const body=await response.json(),[score]=await real([["ZSCORE","nl:cimg:doors",path]]),before=await picturesKept(folder);
  const swept=await sweepCommunityUploads(Date.now()+2*day);
  console.log("Z_LIVE_PICTURE",JSON.stringify({status:response.status,error:body.error,tokens:tokens.length,listed:score!==null,placesBeforeSweep:before,swept,deleted:deleted.includes(path),fileStillPresent:files.has(path),placesAfterSweep:await picturesKept(folder),commands:batches.flat().map(c=>c[0]),jsonPipelineBytes:batches.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0)}));
  assert.equal(response.status,500);assert.equal(tokens.length,0);
  assert.equal(files.has(path),true,"a failed re-request for a path already consumed by a post must not make the sweep delete its existing picture");
});
