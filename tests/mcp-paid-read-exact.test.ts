// Codex J's proof on #1821 (codex/j-review-1821-paid-read@f1d34a28, tests/j-1821-paid-read.proof.ts), kept as a discovered test with its assertions unchanged.
/** Independent #1821 evidence. Real MCP route and Redis writers; only malformed replies are injected. */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { apiReadUnits, savedBlocksWork, SAVED_SECTIONS_MAX } from "@/lib/api-read-rules";
import { writeSection } from "@/lib/saved-block-store";
import { newSectionId, readSectionInput } from "@/lib/saved-blocks";
import { EMPTY_PAGE, newBlockId } from "@/lib/sales-page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";
import { readFileSync } from "node:fs";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let mode = "", prefix = "", sectionKey = "", reads = 0, injected = 0;
let reply: unknown[] = [];
let concurrent: (() => Promise<void>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (mode === "race" && batch.some(c => c[0] === "HLEN" && c[1] === sectionKey)) {
    mode = ""; injected++;
    await concurrent!();
  }
  if (batch.some(c => String(c[0]) === "HVALS" && c[1] === sectionKey)) reads += Buffer.byteLength(JSON.stringify(values));
  if (mode === "unknown" && batch.some(c => !["LLEN", "HLEN"].includes(String(c[0])) && String(c[1]).startsWith(prefix))) { injected++; return reply; }
  return values;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => { throw new Error("No external provider in J evidence"); }) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "j-mcp-evidence@example.com";
  await claimHandle(owner, "j-mcp-evidence", "J Synthetic Store", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId:"cus_JMcp00000001", subscriptionId:"sub_JMcp00000001", active:true, tier:"scale", cycle:"month", period:paidPeriod() });
  const made = await addProduct(owner, "Guide", "", "29", null);
  if (!made.ok) throw new Error("fixture product");
  const store = (await storeForEmail(owner))!;
  const key = await makeKey(store.sid, "J evidence");
  if (!key.ok) throw new Error("fixture key");
  const p = made.product.id;
  const pageKey = `nl:product:page:${store.statsId}:${p}`;
  const versionsKey = `nl:product:pages:${store.statsId}:${p}`;
  sectionKey = `nl:sblocks:${store.statsId}`;
  const page = { ...EMPTY_PAGE, blocks:[{ id:newBlockId(), kind:"hero", headline:"A real saved headline", sub:"", button:"Read", picture:null }] };
  await real([["SET",pageKey,JSON.stringify(page)],["RPUSH",versionsKey,`1800000000000\n${JSON.stringify(page)}`]]);
  let id = 0;
  const call = async (name:string) => {
    const r = await POST(new Request("https://marktmorgen.com/api/mcp",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key.key}`},body:JSON.stringify({jsonrpc:"2.0",id:++id,method:"tools/call",params:{name,arguments:{product:p}}})}));
    const body = await r.json() as { result?:{isError:boolean;content:{text:string}[]};error?:unknown };
    const text = body.result?.content[0]?.text ?? "";
    return { rejected:Boolean(body.error || body.result?.isError), value:text ? JSON.parse(text) as Record<string,unknown> : {}, sent:Buffer.byteLength(text) };
  };
  const pageControl = await call("get_sales_page"), versionsControl = await call("get_page_versions");
  is("real page control has one block", [pageControl.rejected,(pageControl.value.blocks as unknown[]).length],[false,1]);
  is("real versions control has one version",[versionsControl.rejected,(versionsControl.value.versions as unknown[]).length],[false,1]);
  for (const [label,tool,target,bad] of [
    ["page missing envelope","get_sales_page",pageKey,[]],
    ["page boolean slot","get_sales_page",pageKey,[false]],
    ["page extra envelope","get_sales_page",pageKey,[JSON.stringify(page),99]],
    ["versions missing envelope","get_page_versions",versionsKey,[]],
    ["versions boolean slot","get_page_versions",versionsKey,[false]],
    ["versions partial row","get_page_versions",versionsKey,[[null]]],
    ["sections unreadable row","list_saved_blocks",sectionKey,[[null]]],
  ] as [string,string,string,unknown[]][]) {
    mode="unknown"; prefix=target; reply=bad; injected=0;
    // Version probing itself must remain exact; only the content LRANGE is injected.
    if (tool === "get_page_versions") prefix=target;
    const result=await call(tool); mode="";
    is(label+" is actually injected",injected>0,true);
    is(label+" cannot certify empty or complete content",result.rejected || result.value.sections===null,true);
  }
  // A valid zero count is observed, then many legitimate writes finish before HVALS.
  await real([["DEL",sectionKey]]);
  const input=readSectionInput("A saved section",Array.from({length:8},()=>({id:newBlockId(),kind:"faq",heading:"Questions",items:Array.from({length:10},()=>({q:"Q".repeat(100),a:"A".repeat(330)}))})));
  if (!input.ok) throw new Error("valid section fixture: "+input.error);
  const n=Math.min(40,SAVED_SECTIONS_MAX); let written=0;
  concurrent=async()=>{for(let i=0;i<n;i++){const saved=await writeSection(store.statsId!,{id:newSectionId(),name:"Section "+i,blocks:input.blocks,updatedAt:1800000000+i},true,SAVED_SECTIONS_MAX);if(saved!=="ok")throw new Error("concurrent writer refused");written++;}};
  reads=0;mode="race";injected=0;
  const before=await allowanceUsed(store,"api");
  const raced=await call("list_saved_blocks");
  const taken=await allowanceUsed(store,"api")-before;
  const due=1+apiReadUnits({commands:2,bytes:reads,sent:raced.sent,roundTrips:2});
  console.log(JSON.stringify({race:{written,returned:(raced.value.sections as unknown[]|undefined)?.length,readBytes:reads,sentBytes:raced.sent,taken,due,zeroEnvelope:savedBlocksWork(0)}}));
  is("concurrent real writers succeeded",[written,injected],[n,1]);
  is("a stale count never permits a reading larger than its prepaid share",raced.rejected || taken>=due,true);
  const healthyBefore=await allowanceUsed(store,"api"); reads=0;
  const healthy=await call("list_saved_blocks");
  const healthyTaken=await allowanceUsed(store,"api")-healthyBefore;
  is("stable sections control is read and charged for its complete size",[healthy.rejected,(healthy.value.sections as unknown[]).length,healthyTaken>=1+apiReadUnits({commands:2,bytes:reads,sent:healthy.sent,roundTrips:2})],[false,n,true]);
  is("agent-store feature status does not advertise the two deferred number tools",readFileSync("docs/ai-agent-store.md","utf8").includes("the store's numbers, live and today, any stretch of days"),false);
  done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
