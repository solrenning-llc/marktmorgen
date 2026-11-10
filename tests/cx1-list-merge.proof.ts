import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { importContactRows, leadsKey } from "@/lib/contacts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { GET } from "@/app/api/store/leads/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const owner = "cx1-list-merge@example.com";
  await claimHandle(owner, "cx1listmerge", "CX1 list merge", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner,{customerId:"cus_Cx1ListMerge",subscriptionId:"sub_Cx1ListMerge",active:true,tier:"creator",trialEnds:0,period:paidPeriod()});
  const store = (await storeForEmail(owner))!;
  await importContactRows(store.listId!,[{email:"cx1-readable@example.com",name:"Readable",tags:[],consent:"agreed"}],store);
  await redis.pipeline([["HSET",leadsKey(store.listId!),"cx1-broken@example.com","{broken"]]);
  const token=await openSession(owner);
  const request=()=>new NextRequest("https://marktmorgen.com/api/store/leads",{headers:{cookie:`${SESSION_COOKIE}=${token}`}});
  part("CX1 merge: partial export and funded reads coexist");
  const response=await GET(request());
  const csv=await response.text();
  is("partial file still delivered",response.status,200);
  is("partial name identifies unread contact",response.headers.get("content-disposition")?.includes("-partial-1-contact-not-read.csv"),true);
  is("readable contact retained",csv.includes("cx1-readable@example.com"),true);
  is("malformed row not fabricated",csv.includes("cx1-broken@example.com"),false);
  const original=redis.pipeline.bind(redis);
  let scans=0;
  redis.pipeline=async commands=>{
    if(commands.some(c=>c[0]==="HSCAN")){scans++;throw new Error("synthetic HSCAN unavailable");}
    return original(commands);
  };
  try { is("failed held read returns retryable failure",(await GET(request())).status,502); }
  finally {redis.pipeline=original;}
  is("failure reached the real list read",scans,1);
  await forceAllowance(store,"studio",STORE_ALLOWANCES.creator.studio);
  scans=0;
  redis.pipeline=async commands=>{if(commands.some(c=>c[0]==="HSCAN"))scans++;return original(commands);};
  try {is("spent studio figure refuses download",(await GET(request())).status,429);}
  finally {redis.pipeline=original;}
  is("no HSCAN beyond the figure",scans,0);
  done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
