/** Independent synthetic boundary controls for #2965; never a real provider request. */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStoreId, setProductCall, setStripeAccount, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesOpen, runningSeries, seriesOpenKey } from "@/lib/call-series-open";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { POST as taxRoute } from "@/app/api/store/tax/route";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_p_series_boundary";
let mockedRequests = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (++mockedRequests > 100) throw Error("mock request ceiling");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.stripe.com") throw Error("external network prohibited");
  if (url.pathname === "/v1/tax/settings") return Response.json({ status: "active" });
  if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "p.series.boundary@example.com";
  await claimHandle(owner, "pseriesboundary", "Series boundary", "");
  await ensureStoreId(owner);
  const call = await addProduct(owner, "Call", "", "80", null);
  if (!call.ok) throw Error("fixture product");
  await setProductCall(owner, call.product.id, {kind:"weekly",minutes:60,tz:"UTC",weekly:[[],[[540,1020]],[],[],[],[],[]],noticeHours:12,horizonDays:30,bufferMinutes:0,room:"https://example.com/room",video:false,meet:null,seats:1,sessions:[]} as unknown as CallSetup);
  await setStripeAccount(owner, "acct_1PSeriesBound", true);
  const store = (await storeForEmail(owner))!;
  await markSeriesOpen({...store,callsId:store.callsId!}, "a".repeat(32), Date.now()+86400000);
  const key = seriesOpenKey(store.callsId!);
  const session = await openSession(owner);
  const real = redis.pipeline.bind(redis);
  let effects = 0;
  const hole = new Array(1);
  const inherited = new Array(1); Object.setPrototypeOf(inherited, {0:0});
  const getter = Object.defineProperty([0], "0", {get(){effects++; return 0;}});
  const proxy = new Proxy([0], {get(target, property, receiver){if(property==="then")return undefined;effects++; return Reflect.get(target,property,receiver);},getOwnPropertyDescriptor(){effects++; throw Error("proxy descriptor trap");}});
  const shapes: [string, unknown][] = [
    ["missing", [undefined]], ["null",[null]], ["text zero",["0"]], ["fraction",[0.25]],
    ["negative",[-1]], ["NaN",[NaN]], ["infinite",[Infinity]], ["unsafe",[Number.MAX_SAFE_INTEGER+1]],
    ["object",[{n:0}]], ["empty",[]], ["extra",[0,0]], ["hole",hole], ["inherited",inherited],
    ["getter",getter], ["proxy",proxy],
  ];
  const send = async (route:typeof taxRoute,path:string,body:Record<string,unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, {method:"POST",headers:{"content-type":"application/json",cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify(body)}));
    return [response.status, (await response.json()).error ?? "ok"];
  };
  const tax = {enabled:true,included:false,ids:false,invoices:false};
  for (const [label, reply] of shapes) {
    redis.pipeline = (async commands => commands.some(c=>c[0]==="ZCOUNT"&&c[1]===key)?reply:real(commands)) as typeof redis.pipeline;
    let outcome = "returned";
    try { await runningSeries(store); } catch(error) { outcome=error instanceof UnknownReplyError?"unknown":"other"; }
    is(`${label}: typed unknown`,outcome,"unknown");
    is(`${label}: currency refuses`,await send(currencyRoute,"currency",{currency:"eur",confirm:true}),[503,"unavailable"]);
    is(`${label}: tax refuses`,await send(taxRoute,"tax",tax),[503,"unavailable"]);
    const current = (await storeForEmail(owner))!;
    is(`${label}: settings unchanged`,[current.currency,current.tax.enabled,current.tax.ids,current.tax.invoices],["usd",false,false,false]);
  }
  is("no getter or proxy trap evaluated",effects,0);
  for (const count of [0,1,2,Number.MAX_SAFE_INTEGER]) {
    redis.pipeline = (async commands=>commands.some(c=>c[0]==="ZCOUNT"&&c[1]===key)?[count]:real(commands)) as typeof redis.pipeline;
    is(`safe integer ${count} retained`,await runningSeries(store),count);
  }
  redis.pipeline = (async commands=>{if(commands.some(c=>c[0]==="ZCOUNT"&&c[1]===key))throw Error("synthetic connection failure");return real(commands);}) as typeof redis.pipeline;
  is("other error keeps currency 500",await send(currencyRoute,"currency",{currency:"eur",confirm:true}),[500,"server_error"]);
  is("other error keeps tax 500",await send(taxRoute,"tax",tax),[500,"server_error"]);
  redis.pipeline = real;
  is("healthy currency still blocked by real series",await send(currencyRoute,"currency",{currency:"eur",confirm:true}),[409,"series"]);
  is("healthy tax still blocked by real series",await send(taxRoute,"tax",tax),[409,"series"]);
  console.log("Synthetic HTTP replies:",mockedRequests);
  done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
