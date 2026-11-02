import {publicStandardAx2Run} from "./ax2-public-run.mjs";
import {setAnswers,setProductShipping,setPixels} from "@/lib/store";
import {TIERS,publishedPriceWords} from "@/lib/plan";
import type { CallSetup } from "@/lib/call-setup";
import { setProductCall } from "@/lib/store";
import { makeLink } from "@/lib/numbers-links";
import { addNumbersLink } from "@/lib/store";
import { DEMO_STORE, DEMO_PRODUCT, DEMO_EXTRAS, DEMO_PAGE } from "@/lib/demo-seed";
import {paidPeriod} from "../billing-period-fixture";
import {DEMO_CONNECTED_ACCOUNT} from "@/lib/demo-account";
import { readFields, writeFields } from "@/lib/crm";
import { findToken } from "@/lib/buyer-profile";
import { KIND } from "@/lib/catalog";
import {writePage} from "@/lib/sales-page-store";
import {parsePage} from "@/lib/sales-page";
import {redisPipeline} from "@/lib/redis";
import {setProductPage,setProductFile,setStripeAccount,storeForEmail,setPauseMonths} from "@/lib/store";
import { startPath } from "@/lib/path";
import { localDay,mayNotify } from "@/lib/path-rules";
/**
 * The stores tests/e2e/store-copy.mjs opens: one with three products, and a
 * second store of the same owner to copy it into, both on a running plan,
 * with a session for their owner.
 */
import { addProduct, claimHandle, createStore, ensureStatsId, setMailSettings, setSubscription, storeRef } from "@/lib/store";
import { openSession } from "@/lib/auth";
const OWNER = "owner@example.com";
async function main(): Promise<void> {
  const claimed = await claimHandle(OWNER, "signshop", "Harbor Coaching Local", "Coaching sessions.");
  if (!claimed.ok) throw new Error(claimed.reason);
  await setSubscription(OWNER, { active: true, tier: "creator", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 });
  await setMailSettings(OWNER, { fromName: "Harbor Coaching", address: "1 Main St, Austin, TX 78701" });
  await ensureStatsId(OWNER);
  for (const t of ["One session", "Four sessions", "Free checklist"]) await addProduct(OWNER, t, "Words.", t.startsWith("Free") ? "0" : "40", null);
  const abStore=(await storeForEmail(OWNER))!;
  const abProduct=abStore.catalog.items.find(product=>(product.kind & KIND.paid)!==0)?.id;
  if(!abProduct)throw Error("No paid synthetic experiment product");
  const abPage=parsePage({blocks:[{id:"abhero01",kind:"hero",headline:"One session",sub:"A local synthetic fixture",media:"none",video:null}],test:{headline:"Try a coaching session",sub:""}});
  if(!abPage.test || !abStore.statsId)throw Error("No synthetic experiment");
  await writePage(abStore.statsId,abProduct,abPage,abStore);
  if(!(await setProductPage(OWNER,abProduct,true)).ok)throw Error("Synthetic page was not indexed");
  await redisPipeline([["HSET",`nl:ab:${abStore.statsId}:${abProduct}:${abPage.test.id}`,"va","NaN"]]);
  if(!abStore.statsId)throw Error("No contact fixture store");
  await writeFields(abStore.statsId,[{id:"cmp001",name:"Company",type:"text",options:[]},{id:"seg001",name:"Segment",type:"choice",options:["New","Returning"]}]);
  if((await readFields(abStore.statsId)).length!==2)throw Error("Invalid synthetic contact field schema");
  const contactToken=await findToken(abStore,"contact-fixture@example.test");
  if(!contactToken)throw Error("No contact fixture token");
  const second = await createStore(OWNER, "secondshop", "Second Coaching", "");
  if (!second.ok) throw new Error("no second");
  await ensureStatsId(storeRef(second.store));
  await setSubscription(storeRef(second.store), { active: true, tier: "creator", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 });
  const reminderNow=Date.now();
  const reminderZone=["Europe/London","Asia/Tokyo","Pacific/Honolulu"].find(zone=>mayNotify(zone,reminderNow));
  if(!reminderZone)throw new Error("No daytime test zone");
  const reminderStarted=await startPath(second.store,{goalCents:0,goalCurrency:"usd",skills:"",subject:"",minutes:15,audience:"none",timeZone:reminderZone},reminderNow-86400000);
  if(!reminderStarted.ok)throw new Error("No synthetic Path");

  // Separate synthetic owner: post-sale Path evidence never changes the copy fixtures.
  const growthOwner="path-growth-owner@example.test";
  const growthClaim=await claimHandle(growthOwner,"growthpath","Growth Path","Guides.");
  if(!growthClaim.ok)throw Error("No growth store");
  await setSubscription(growthOwner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0});
  await ensureStatsId(growthOwner);
  const growthProducts:string[]=[];
  for(const title of ["First guide","Second guide"]){
    const added=await addProduct(growthOwner,title,"Synthetic file guide.","10",null);
    if(!added.ok)throw Error("No growth product");
    growthProducts.push(added.product.id);
    const attached=await setProductFile(growthOwner,added.product.id,{pathname:"stores/path-growth/"+added.product.id+"/guide.pdf",name:"guide.pdf",bytes:100,contentType:"application/pdf",addedAt:new Date().toISOString()});
    if(!attached.ok)throw Error("No growth file");
  }
  if(!(await setStripeAccount(growthOwner,DEMO_CONNECTED_ACCOUNT,true)).ok)throw Error("No growth synthetic account");
  const growthStore=(await storeForEmail(growthOwner))!;
  const certificateHeadingFixture=publicStandardAx2Run()?{handle:growthStore.handle,name:"Łukasz Żółć",title:"Synthetic course title",certs:[{id:"ax2certen0000000",withdrawn:false},{id:"ax2goneen0000000",withdrawn:true}]}:null;
  if(certificateHeadingFixture)for(const cert of certificateHeadingFixture.certs){
    await redisPipeline([["SET","nl:cert:"+cert.id,JSON.stringify({id:cert.id,store:growthStore.statsId,productId:growthProducts[0],courseId:"ax2-heading-course",name:certificateHeadingFixture.name,title:certificateHeadingFixture.title,creator:growthStore.name,email:"synthetic-certificate@example.test",issuedAt:1791580800,withdrawnAt:cert.withdrawn?1791667200:0})]]);
  }
  if(!(await startPath(growthStore,{goalCents:0,goalCurrency:"usd",skills:"Teaching",subject:"Guides",minutes:15,audience:"none",timeZone:"America/New_York"})).ok)throw Error("No growth Path");
  const growthSession=await openSession(growthOwner);
  const returnOwner="path-return-owner@example.test";
  if(!(await claimHandle(returnOwner,"returnpath","Return Path","A first introduction.")).ok)throw Error("No return store");
  await setSubscription(returnOwner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0});
  const returnStore=(await ensureStatsId(returnOwner))!;
  const returnNow=Date.now(),returnStart=new Date(localDay("America/New_York",returnNow)+"T12:00:00Z");
  returnStart.setUTCDate(returnStart.getUTCDate()-8);
  if(!(await startPath(returnStore,{goalCents:0,goalCurrency:"usd",skills:"Teaching",subject:"Guides",minutes:15,audience:"none",timeZone:"America/New_York"},returnStart.getTime())).ok)throw Error("No return Path");
  const returnSession=await openSession(returnOwner);
  const wordingOwner="path-wording-owner@example.test";
  if(!(await claimHandle(wordingOwner,"wordingpath","Wording Path","")).ok)throw Error("No wording owner");
  if(!(await setSubscription(wordingOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:"sub_wordingSynthetic",customerId:"cus_wordingSynthetic",trialEnds:0,period:paidPeriod()})))throw Error("No paid wording subscription");
  const wordingStore=(await ensureStatsId(wordingOwner))!;
  const wordingAnswers={goalCents:700000,goalCurrency:"usd",skills:"Private skill words",subject:"Private topic words",minutes:15,audience:"instagram",timeZone:"America/New_York"} as const;
  if(!(await startPath(wordingStore,wordingAnswers)).ok)throw Error("No wording Path");
  const wordingSession=await openSession(wordingOwner);
  const wordingTrialOwner="path-wording-trial@example.test";
  if(!(await claimHandle(wordingTrialOwner,"wordingtrial","Trial Path","")).ok)throw Error("No wording trial");
  if(!(await setSubscription(wordingTrialOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:"sub_wordingTrial",customerId:"cus_wordingTrial",trialEnds:Math.floor(Date.now()/1000)+86400})))throw Error("No trial wording subscription");
  const wordingTrialStore=(await ensureStatsId(wordingTrialOwner))!;
  if(!(await startPath(wordingTrialStore,wordingAnswers)).ok)throw Error("No trial Path");
  const wordingTrialSession=await openSession(wordingTrialOwner);
  // Isolated local-only recurring stores: test both enabling and disabling pause
  // without changing existing Path/copy fixtures or touching a payment provider.
  const pauseFixtures: {session:string;sid:string;initial:number}[]=[];
  for(const initial of [0,1]){
    const owner=`pause-fixture-${initial}@example.test`;
    const claim=await claimHandle(owner,`pausefixture${initial}`,"Pause fixture","Synthetic local settings.");
    if(!claim.ok)throw Error("No local pause fixture");
    await setSubscription(owner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
    await ensureStatsId(owner);
    const product=await addProduct(owner,"Synthetic monthly membership","Local fixture only.","10",{interval:"month",trialDays:0,payments:0});
    if(!product.ok)throw Error("No local recurring fixture");
    if(!(await setPauseMonths(owner,initial)).ok)throw Error("No local pause setting");
    const saved=await storeForEmail(owner);
    if(!saved?.period || saved.pause!==initial || !saved.catalog.items.some(item=>(item.kind & KIND.recurring)!==0))throw Error("Incomplete local pause fixture");
    pauseFixtures.push({session:await openSession(owner),sid:saved.sid,initial});
  }
  // Isolated guide fixture: only disposable local Redis and test configuration.
  const guideOwner="guide-placement@example.test",guideHandle="guideplacementfixture";
  if(!(await claimHandle(guideOwner,guideHandle,"Guide placement fixture","Synthetic local catalog.")).ok)throw Error("No guide fixture");
  await setSubscription(guideOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
  await ensureStatsId(guideOwner);
  await setStripeAccount(guideOwner,DEMO_CONNECTED_ACCOUNT,true);
  if(!(await setAnswers(guideOwner,{on:true,facts:"Synthetic catalog only."})))throw Error("No guide setting");
  const guideProducts=[];
  for(const title of ["Synthetic dinners","Synthetic baking","Synthetic planner"]){
    const added=await addProduct(guideOwner,title,"Synthetic local guide product.","10",null);
    if(!added.ok)throw Error("No guide product");
    guideProducts.push({id:added.product.id,title});
  }
  const guideFixture={handle:guideHandle,products:guideProducts};
  // Isolated local Harbor Kitchen fixture: canonical demo content, no external account or upload.
  const homeOwner="home-demo@example.test";
  const homeClaim=await claimHandle(homeOwner,"harborkitchenpreview",DEMO_STORE.name,DEMO_STORE.bio);
  if(!homeClaim.ok||DEMO_STORE.tier!=="pro")throw Error("No local demo studio fixture");
  await setSubscription(homeOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
  await ensureStatsId(homeOwner);
  await setStripeAccount(homeOwner,DEMO_CONNECTED_ACCOUNT);
  let homeProductId:string|null=null;
  for(const product of [DEMO_PRODUCT,...DEMO_EXTRAS]){
    const added=await addProduct(homeOwner,product.title,product.summary,product.price,null);
    if(!added.ok)throw Error("No local demo product");
    if(product.title===DEMO_PRODUCT.title)homeProductId=added.product.id;
  }
  const homeStore=await storeForEmail(homeOwner);
  const homeProduct=homeStore?.catalog.items.find(product=>product.id===homeProductId);
  const homePage=parsePage(DEMO_PAGE);
  if(!homeStore?.statsId||!homeProduct||!homePage)throw Error("No local demo page");
  await writePage(homeStore.statsId,homeProduct.id,homePage,homeStore);
  if(!(await setProductPage(homeOwner,homeProduct.id,true)).ok)throw Error("No local demo page index");
  const homeDemo={session:await openSession(homeOwner),sid:homeStore.sid,product:homeProduct.id};
  // Isolated synthetic exit-offer settings: unaffected by the copy suite's owner mutations.
  const exitOwner="exit-offer-fixture@example.test";
  if(!(await claimHandle(exitOwner,"exitofferfixture","Exit offer fixture","Synthetic settings only.")).ok)throw Error("No exit offer fixture");
  await setSubscription(exitOwner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0});
  await ensureStatsId(exitOwner);
  if(!(await addProduct(exitOwner,"Free fixture checklist","Synthetic local checklist.","0",null)).ok)throw Error("No free exit offer fixture");
  const exitStore=await storeForEmail(exitOwner);
  if(!exitStore)throw Error("No saved exit offer fixture");
  const exitFixture={session:await openSession(exitOwner),sid:exitStore.sid};
  // Isolated local membership settings; no subscription checkout or external provider.
  const tierOwner="tier-settings-fixture@example.test";
  if(!(await claimHandle(tierOwner,"tiersettingsfixture","Tier settings fixture","Synthetic settings only.")).ok)throw Error("No tier fixture");
  await setSubscription(tierOwner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0});
  await ensureStatsId(tierOwner);
  const tierProductIds:string[]=[];
  for(const title of ["First fixture membership","Second fixture membership"]){
    const added=await addProduct(tierOwner,title,"Synthetic local membership.","10",{interval:"month",trialDays:0,payments:0});
    if(!added.ok)throw Error("No tier product fixture");
    tierProductIds.push(added.product.id);
  }
  const numbersMade=makeLink({label:"Synthetic partner",password:"synthetic-password",days:30,money:false},Date.now());
  if(!numbersMade.ok || !(await addNumbersLink(tierOwner,numbersMade.link,Date.now())).ok)throw Error("No synthetic numbers link");
  const tierStore=await storeForEmail(tierOwner);
  if(!tierStore)throw Error("No saved tier fixture");
  const tierFixture={session:await openSession(tierOwner),sid:tierStore.sid,ids:tierProductIds,numbersLinkId:numbersMade.link.id};
  const packageOwner="package-settings-fixture@example.test";
  if(!(await claimHandle(packageOwner,"packagesettingsfixture","Package fixture","Synthetic settings only.")).ok)throw Error("No package fixture");
  await setSubscription(packageOwner,{active:true,tier:"creator",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0});
  await ensureStatsId(packageOwner);
  const packageProduct=await addProduct(packageOwner,"Synthetic weekly call","Synthetic local call.","120",null);
  if(!packageProduct.ok)throw Error("No package fixture product");
  const weekly:CallSetup={kind:"weekly",minutes:60,tz:"America/New_York",weekly:[[],[[540,1020]],[],[],[],[],[]],noticeHours:12,horizonDays:30,bufferMinutes:0,room:"https://example.test/synthetic-room",video:false,meet:null,seats:1,sessions:[]};
  if(!(await setProductCall(packageOwner,packageProduct.product.id,weekly)).ok)throw Error("No package fixture call");
  const packageStore=await storeForEmail(packageOwner);
  if(!packageStore)throw Error("No package fixture store");
  const packageFixture={session:await openSession(packageOwner),sid:packageStore.sid,product:packageProduct.product.id};
  const activationOwner="activation-onboarding-fixture@example.test";
  if(!(await claimHandle(activationOwner,"activationonboarding","Activation fixture","")).ok)throw Error("No activation fixture");
  await setSubscription(activationOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
  const activationStore=await storeForEmail(activationOwner);if(!activationStore)throw Error("No activation store");
  const activationFixture={session:await openSession(activationOwner),sid:activationStore.sid};
  const libraryOwner="template-library-fixture@example.test";
  if(!(await claimHandle(libraryOwner,"templatelibraryfixture","Template library fixture","Synthetic local tests.")).ok)throw Error("No library fixture");
  await setSubscription(libraryOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
  await setMailSettings(libraryOwner,{fromName:"Synthetic creator",address:"123 Synthetic Street, Example City, NY 10001"});
  await ensureStatsId(libraryOwner);
  const libraryProduct=await addProduct(libraryOwner,"Synthetic template product","Synthetic product summary.","10",null);
  if(!libraryProduct.ok)throw Error("No library fixture product");
  if(!(await setStripeAccount(libraryOwner,DEMO_CONNECTED_ACCOUNT,true)).ok)throw Error("No local synthetic library Stripe fixture");
  const libraryStore=await storeForEmail(libraryOwner);if(!libraryStore)throw Error("No library fixture store");
  const preservedProduct=await addProduct(libraryOwner,"Saved creator page","Keep this creator content.","20",null);
  if(!preservedProduct.ok || !libraryStore.statsId)throw Error("No preserved page fixture");
  await writePage(libraryStore.statsId,preservedProduct.product.id,parsePage({blocks:[{id:"kephero1",kind:"hero",headline:"Keep my creator headline",sub:"Keep my creator wording",media:"none",video:null}]}),libraryStore);
  if(!(await setProductPage(libraryOwner,preservedProduct.product.id,true)).ok)throw Error("No preserved page index");
  if(!(await setPixels(libraryOwner,{meta:"123456789012345",google:"G-AB12CD34EF",tiktok:"C4ABCDEFGH1234567890",pinterest:null,x:null})).ok)throw Error("No synthetic pixel fixture");
  const libraryFixture={preservedProduct:preservedProduct.product.id,session:await openSession(libraryOwner),sid:libraryStore.sid,product:libraryProduct.product.id};
  const shippingOwner="shipping-proof@example.test";
  if(!(await claimHandle(shippingOwner,"shippingprooffixture","Shipping proof fixture","Synthetic local tests.")).ok)throw Error("No shipping fixture");
  await setSubscription(shippingOwner,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0,period:paidPeriod()});
  const shippingProduct=await addProduct(shippingOwner,"Synthetic physical product","Synthetic shipping proof.","10",null);
  if(!shippingProduct.ok)throw Error("No shipping product");
  if(!(await setProductShipping(shippingOwner,shippingProduct.product.id,{cents:500,region:"us",countries:["US"],note:"Ships later",sku:"Synthetic-SKU"})).ok)throw Error("No saved shipping");
  const shippingStore=await storeForEmail(shippingOwner);if(!shippingStore)throw Error("No shipping store");
  const shippingFixture={session:await openSession(shippingOwner),sid:shippingStore.sid,product:shippingProduct.product.id};
  // A separate synthetic owner for the real studio billing observation flow.
  const billingOwner = "studio-observation@example.test";
  const billingClaim = await claimHandle(billingOwner, "billing-observation", "Synthetic billing observation", "");
  if (!billingClaim.ok) throw new Error("billing observation fixture refused");
  await ensureStatsId(billingOwner);
  const billingStore = await setSubscription(billingOwner, { customerId: "cus_StudioObservation01", subscriptionId: "sub_StudioObservation01", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  if (!billingStore?.subscriptionActive || !billingStore.period) throw new Error("billing observation paid fixture missing");
  const billingDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nimbus-store:" + billingOwner));
  const billingKey = "nl:store:owner:" + Array.from(new Uint8Array(billingDigest), n => n.toString(16).padStart(2, "0")).join("").slice(0, 40);
  const billingObservation = { session: await openSession(billingOwner), sid: billingStore.sid, key: billingKey };
  console.log(JSON.stringify({ guideFixture,billingObservation,certificateHeadingFixture,shippingFixture,libraryFixture,signinPrices:TIERS.map(tier=>({tier,words:publishedPriceWords(tier,"month")})),activationFixture,packageFixture,tierFixture,exitFixture,homeDemo,pauseFixtures,wordingSession,wordingSid:wordingStore.sid,wordingTrialSession,wordingTrialSid:wordingTrialStore.sid,returnSession,returnSid:returnStore.sid,growthSession,growthSid:growthStore.sid,growthProduct:growthProducts[0],session: await openSession(OWNER), second: second.store.sid, abProduct, abStore:abStore.sid,contactToken }));
}
main().catch((e) => { console.error(e); process.exit(1); });
