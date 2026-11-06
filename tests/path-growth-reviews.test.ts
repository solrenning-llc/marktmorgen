import {pathBuyerReview,saveReview,setHidden,deleteReview,markOneRefunded} from "@/lib/reviews";
import {store as redis} from "./redis-stub";
import {ROOM} from "./data-room";
import {done,is,part} from "./check";
const stats="d".repeat(32),product="knife00001",listed=new Set([product]);
async function main(){
 redis.clear();
 part("Only a current own buyer-written live checkout review is evidence");
 is("no current review",await pathBuyerReview(stats,listed,3),false);
 const create=async(email:string,reference:string,text="My experience")=>{
  const saved=await saveReview(stats,{productId:product,email,reference,pi:"pi_"+email.split("@")[0],rating:5,text,name:"Buyer"},ROOM,1790000000000);
  if(saved.state!=="created")throw new Error("review fixture");
  return saved.review.id;
 };
 await create("test@example.test","cs_test_1234567890123");
 is("test reference never proves live purchase",await pathBuyerReview(stats,listed,3),null);
 redis.clear();
 await create("intent@example.test","pi_123456789012345");
 is("intent reference has no live mode",await pathBuyerReview(stats,listed,3),null);
 redis.clear();
 const id=await create("live@example.test","cs_live_123456789012345");
 is("explicit buyer-posted current review",await pathBuyerReview(stats,listed,3),true);
 is("not another store's listed product",await pathBuyerReview(stats,new Set(["other00001"]),3),false);
 await setHidden(stats,product,id,true,"abusive");
 is("hidden review not evidence",await pathBuyerReview(stats,listed,3),false);
 await setHidden(stats,product,id,false);
 await markOneRefunded(stats,product,id);
 is("refunded review not evidence",await pathBuyerReview(stats,listed,3),false);
 redis.clear();
 const withdrawn=await create("withdraw@example.test","cs_live_123456789012345");
 await deleteReview(stats,product,withdrawn,ROOM);
 is("buyer withdrawal removes evidence",await pathBuyerReview(stats,listed,3),false);
 redis.clear();
 await create("empty@example.test","cs_live_123456789012345","");
 is("rating without words not a testimonial",await pathBuyerReview(stats,listed,3),false);
 const pipeline=redis.pipeline;
 try{
  redis.pipeline=async()=>[null,0];
  is("malformed index is not empty evidence",await pathBuyerReview(stats,listed,3),null);
  redis.pipeline=async()=>[[],1];
  is("missing indexed record is unavailable",await pathBuyerReview(stats,listed,3),null);
 }finally{redis.pipeline=pipeline;}
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
