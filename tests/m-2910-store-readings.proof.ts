/** Independent M proof: real pages/rules, canonical MemoryRedis and SSR. Not executed during recovery. */
import {createHash} from "node:crypto";
import {renderToReadableStream} from "react-dom/server";
import {NextRequest} from "next/server";
import EmbedCard,{generateMetadata as cardMetadata} from "@/app/embed/[handle]/[product]/page";
import EmbedJoin from "@/app/embed/[handle]/join/page";
import LibraryPage from "@/app/library/page";
import {POST as requestLibrary} from "@/app/api/library/route";
import {addProduct,claimHandle,ensureStatsId,setLanguage,setProductLink,setStripeAccount,setSubscription,storeForEmail} from "@/lib/store";
import {personWrite} from "@/lib/joined-stores";
import {wordsIn} from "@/lib/buyer-words";
import {productPath} from "@/components/store-product";
import {tagged,placeFrom} from "@/lib/embed-rules";
import {LANGUAGE_CODES,LANGUAGES} from "@/lib/store-language";
import {paidPeriod} from "@/tests/billing-period-fixture";
import {store as redis} from "@/tests/redis-stub";
import {answering} from "@/tests/security/next-headers";

type Command=(string|number)[];
type Fault={when:(batch:Command[])=>boolean;reply:()=>Promise<unknown[]>|unknown[]};
const original=redis.pipeline.bind(redis);
let fault:Fault|null=null;
redis.pipeline=(async(batch:Command[])=>fault?.when(batch)?fault.reply():original(batch)) as typeof redis.pipeline;
const checks:{label:string;pass:boolean;scope:string}[]=[];
let currentCase=0;
function part(n:number){
  currentCase=n;
  (globalThis as unknown as {__m2910Case:(n:number)=>void}).__m2910Case(n);
}
function check(label:string,pass:boolean,scope="four-fixes"){checks.push({label,pass,scope});}
const failed=()=>Promise.reject(new Error("M synthetic pre-execution Redis failure"));
const command=(op:string,prefix:string)=>(batch:Command[])=>batch.some(c=>c[0]===op&&typeof c[1]==="string"&&c[1].startsWith(prefix));
const flat=(s:string)=>s.replace(/<[^>]*>/g," ").replace(/&#x27;|&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,"&").replace(/\s+/g," ");
type BuyLink={href:string;label:string;markup:string};
function buyLinks(markup:string):BuyLink[]{
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].flatMap(m=>{
    const href=m[1].match(/\bhref="([^"]*)"/)?.[1];
    const classes=m[1].match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/)??[];
    return href&&["btn","st-btn","btn-block"].every(c=>classes.includes(c))?[{href:href.replace(/&amp;/g,"&"),label:flat(m[2]).trim(),markup:m[0]}]:[];
  });
}
const hasBuy=(markup:string,buy:BuyLink)=>buyLinks(markup).some(a=>a.href===buy.href&&a.label===buy.label);
async function html(node:React.ReactElement){const s=await renderToReadableStream(node,{onError:()=>{}});await s.allReady;return new Response(s).text();}
const owner="m2910-owner@example.test",handle="m2910shop",buyer="m2910-buyer@example.test";
async function card(product:string,other=handle){
  answering(new NextRequest(`https://marktmorgen.com/embed/${other}/${product}`));
  return html(await EmbedCard({params:Promise.resolve({handle:other,product}),searchParams:Promise.resolve({})}) as React.ReactElement);
}
async function join(other=handle){
  answering(new NextRequest(`https://marktmorgen.com/embed/${other}/join`));
  return html(await EmbedJoin({params:Promise.resolve({handle:other}),searchParams:Promise.resolve({})}) as React.ReactElement);
}
async function main(){
  part(1);
  redis.clear();
  process.env.STRIPE_SECRET_KEY="sk_test_m2910_local_only";
  await claimHandle(owner,handle,"M2910 shop","");
  await ensureStatsId(owner);
  await setSubscription(owner,{customerId:"cus_M2910Fixture1",subscriptionId:"sub_M2910Fixture1",active:true,tier:"scale",cycle:"month",period:paidPeriod()});
  await setStripeAccount(owner,"acct_1M2910Fixturexx",true);
  const ids:string[]=[];
  for(let i=0;i<26;i++){
    const added=await addProduct(owner,`M guide ${i+1}`,"Synthetic guide.","40",null);
    if(!added.ok)throw new Error("public product seed failed");
    await setProductLink(owner,added.product.id,`https://example.test/m-${i+1}`);
    ids.push(added.product.id);
  }
  const shop=(await storeForEmail(owner))!;
  const head=new Set(shop.catalog.head.map(p=>p.id));
  const present=ids.find(id=>head.has(id))!,outside=ids.find(id=>!head.has(id))!;
  if(!present||!outside||shop.catalog.inline)throw new Error("public fixture did not produce a listing outside head");
  const presentListing=shop.catalog.head.find(p=>p.id===present)!;
  const expectedBuyHref=tagged(productPath(shop,presentListing),placeFrom(undefined))+"#buy";
  const literalExpectedBuyHref=`/@m2910shop/p/m-guide-1-${present}?utm_source=website&utm_medium=buy-button#buy`;
  const fixtureBuyContract=present===ids[0]&&presentListing.title==="M guide 1"&&expectedBuyHref===literalExpectedBuyHref;
  check("pure fixture buy href matches literal website/buy-button/#buy contract before SSR",fixtureBuyContract,"fixture-contract");
  if(!fixtureBuyContract)throw new Error("M pure fixture purchase URL contract failed before page rendering");
  const expectedBuyLabel=wordsIn("en").buyFor("$40");
  const healthySSR=await card(present);
  const healthyBuy=buyLinks(healthySSR).find(a=>a.href===expectedBuyHref&&a.label===expectedBuyLabel);
  check("healthy paid card retains its exact buy destination and label",Boolean(healthyBuy));
  console.log("M2910_PURCHASE_CONTROL:"+JSON.stringify({expectedBuyHref,literalExpectedBuyHref,fixtureContractSetupOnly:true,expectedBuyLabel,observed:healthyBuy??null,healthySSR}));
  if(!healthyBuy)throw new Error("M healthy purchase fixture did not establish its exact destination and label");
  check("confirmed absent store retains old answer",flat(await card(present,"m2910missing")).includes("This product is no longer on sale."));
  fault={when:command("GET","nl:store:handle:"),reply:failed};
  const unreadStore=await card(present);
  const meta=await cardMetadata({params:Promise.resolve({handle,product:present}),searchParams:Promise.resolve({})});
  fault=null;
  check("store failure is unavailable, never off-sale",flat(unreadStore).includes("could not be loaded just now")&&!flat(unreadStore).includes("no longer on sale"));
  check("store failure metadata is unavailable",meta.title==="Not available just now");
  check("store failure has no checkout form",!unreadStore.includes('action="/api/store/checkout"'));

  part(2);
  for(const code of LANGUAGE_CODES){
    await setLanguage(owner,code);
    fault={when:command("GET",`nl:catalog:${shop.catalog.id}:l:${outside}`),reply:failed};
    const raw=await card(outside);
    fault=null;
    const wanted=(wordsIn(code) as unknown as {cardUnread?:string}).cardUnread;
    check(`${code}: unread product uses its localized sentence`,typeof wanted==="string"&&flat(raw).includes(wanted));
    check(`${code}: unread product retains the store link`,flat(raw).includes(wordsIn(code).seeStore(shop.name)));
    check(`${code}: unread product declares its locale`,raw.includes(`lang="${LANGUAGES[code].locale}"`),"inherited-lang");
  }
  await setLanguage(owner,"en");
  check("confirmed absent product keeps old answer",flat(await card("p_m2910_missing")).includes(wordsIn("en").noLongerOnSale));
  check("healthy card declares its locale",(await card(present)).includes('lang="en-US"'));

  part(3);
  const soon=command("SISMEMBER",`nl:wl:${shop.statsId}:soon`);
  fault={when:soon,reply:()=>[1,null]};
  check("known coming-soon state keeps waitlist",flat(await card(present)).includes(wordsIn("en").joinWaitlist));
  fault={when:soon,reply:failed};
  const unknownSoon=await card(present);
  check("thrown soon read refuses healthy buy destination and checkout form",!hasBuy(unknownSoon,healthyBuy)&&!unknownSoon.includes('action="/api/store/checkout"'));
  check("thrown soon read says unavailable",flat(unknownSoon).includes("Buying is not available just now"));
  check("thrown soon read has no embedded calendar",!unknownSoon.includes("data-embed-calendar"));
  fault={when:soon,reply:()=>[]};
  const shortSoon=await card(present);
  check("short soon envelope refuses healthy buy destination and checkout form",!hasBuy(shortSoon,healthyBuy)&&!shortSoon.includes('action="/api/store/checkout"'),"inherited-soon-shape");
  fault=null;
  check("known ordinary product retains healthy buy destination and label",hasBuy(await card(present),healthyBuy));

  part(4);
  check("missing join store keeps closed answer",flat(await join("m2910missing")).includes("This list is not taking sign-ups"));
  fault={when:command("GET","nl:store:handle:"),reply:failed};
  const unreadJoin=await join();
  fault=null;
  check("join store failure says unavailable",flat(unreadJoin).includes("This form could not be loaded just now"));
  check("join store failure does not say closed",!flat(unreadJoin).includes("not taking sign-ups"));
  check("join store failure has no submit form",!unreadJoin.includes('action="/api/store/join"'));
  check("unknown-store join fallback marks English",unreadJoin.includes('lang="en"'));

  part(5);
  const token="cf".repeat(32);
  await original(personWrite("nl:lib:","nimbus-lib",buyer,shop.sid));
  await original([["SET",`nl:lib:link:${createHash("sha256").update(`nimbus-lib-link:${token}`).digest("hex").slice(0,40)}`,buyer,"EX",86400]]);
  const library=async()=>html(await LibraryPage({searchParams:Promise.resolve({token})}) as React.ReactElement);
  check("whole library reading keeps its store",flat(await library()).includes(shop.name));
  const sunion=(batch:Command[])=>batch.some(c=>c[0]==="SUNION");
  fault={when:sunion,reply:()=>["invalid"]};
  const unreadList=await library();
  check("bad library envelope has notice",flat(unreadList).includes("The stores you bought from could not be read just now"));
  check("bad library envelope never says empty",!flat(unreadList).includes("Nothing is listed for this address"));
  fault={when:sunion,reply:()=>[[]]};
  check("confirmed empty library keeps empty answer",flat(await library()).includes("Nothing is listed for this address"));
  fault={when:command("GET","nl:store:id:"),reply:failed};
  const unreadOne=await library();
  check("thrown store read counts one unread store",flat(unreadOne).includes("1 store could not be read just now"));
  check("thrown store read never says empty",!flat(unreadOne).includes("Nothing is listed for this address"));
  fault={when:command("GET","nl:store:id:"),reply:()=>[]};
  check("short store envelope does not say empty",!flat(await library()).includes("Nothing is listed for this address"),"inherited-store-shape");
  fault=null;
  await claimHandle("m2910-second@example.test","m2910second","M2910 second","");
  const second=(await storeForEmail("m2910-second@example.test"))!;
  await original(personWrite("nl:lib:","nimbus-lib",buyer,second.sid));
  fault={when:command("GET",`nl:store:id:${second.sid}`),reply:failed};
  const mixed=await library();
  fault=null;
  check("mixed library retains readable store",mixed.includes(`data-library-store="${handle}"`));
  check("mixed library reports unread store",flat(mixed).includes("1 store could not be read just now"));
  check("mixed library does not claim empty",!flat(mixed).includes("Nothing is listed for this address"));

  part(6);
  process.env.RESEND_API_KEY="re_test_m2910_blocked";
  const request=async(email:string,ip:string)=>requestLibrary(new NextRequest("https://marktmorgen.com/api/library",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-forwarded-for":ip},body:new URLSearchParams({email})}));
  fault={when:sunion,reply:()=>["invalid"]};
  const errored=await request("m2910-request-a@example.test","198.51.100.181");
  check("unknown library request redirects to error",errored.status===303&&errored.headers.get("location")?.endsWith("/library?status=error")===true);
  fault={when:sunion,reply:()=>[[]]};
  const empty=await request("m2910-request-b@example.test","198.51.100.182");
  fault=null;
  check("known empty library request preserves private sent reply",empty.status===303&&empty.headers.get("location")?.endsWith("/library?status=sent")===true);
  answering(null);
  const summary=checks.reduce<Record<string,{checks:number;failed:number}>>((out,c)=>{const row=out[c.scope]??={checks:0,failed:0};row.checks++;row.failed+=Number(!c.pass);return out;},{});
  console.log("M2910_PROOF:"+JSON.stringify({case:currentCase,summary,checks}));
  if(checks.some(c=>!c.pass))process.exitCode=1;
}
main().catch(error=>{console.error("M2910_PROOF_ERROR",error);process.exitCode=1;});
