import { studioReviews, saveReview } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
const stats = "d".repeat(32), product = "knife00001";
async function main() {
 redis.clear();
 const original = redis.pipeline;
 let calls = 0;
 const refused = async () => { try { await studioReviews(stats,{queue:true,offset:0,limit:20}); return false; } catch { return true; } };
 part("Unknown review indexes never prove absence");
 for (const value of [null, [], [[],0], [null,0,0], [[],null,0], [[],0,"0"], [[],1,1], [[],0,0,null], [["bad"],1,1]]) {
  calls=0;
  redis.pipeline = async () => { calls++; return value as unknown[]; };
  is("unreadable index refused",await refused(),true);
  is("no retry or record read",calls,1);
 }
 redis.pipeline = original;
 is("known empty queue",await studioReviews(stats,{queue:true,offset:0,limit:20}),{rows:[],total:0,unseen:0});
 part("Actual stored reviews and partial reads");
 const saved=await saveReview(stats,{productId:product,email:"buyer@example.test",reference:"cs_test_123456789012345",pi:"pi_synthetic",rating:5,text:"A real synthetic review",name:"Buyer"},ROOM,1790000000000);
 if(saved.state!=="created")throw new Error("fixture");
 const good=await studioReviews(stats,{queue:true,offset:0,limit:20});
 is("stored review retained",good.rows[0]?.id,saved.review.id);
 is("known total retained",good.total,1);
 for (const value of [[],[[]],[[null]]]) {
  redis.pipeline = async commands => commands[0]?.[0]==="HMGET" ? value : original(commands);
  is("partial or unreadable record refused",await refused(),true);
 }
 // Rule 23 (claude5/reviews-recount-exact, the per-product fix): [["not JSON"]] left the list above. A record answered
 // in its exact place that does not read is damaged, not unknown: refusing the page refused every other review on it
 // with no way out, so it is left out and counted instead (tests/reviews-unread-isolated.test.ts).
 redis.pipeline = async commands => commands[0]?.[0]==="HMGET" ? [["not JSON"]] : original(commands);
 const damaged=await studioReviews(stats,{queue:true,offset:0,limit:20});
 redis.pipeline=original;
 is("a damaged record is left out and counted",[damaged.rows.length,damaged.unreadable,damaged.total],[0,1,1]);
 redis.pipeline=original;
 const all=await studioReviews(stats,{queue:false,offset:0,limit:20});
 is("all view preserves unseen flag",all.rows[0]?.unseen,true);
 const beyond=await studioReviews(stats,{queue:true,offset:20,limit:20});
 is("out of range keeps global total",beyond.total,1);
 is("out of range has no page rows",beyond.rows.length,0);
 redis.pipeline=original;
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
