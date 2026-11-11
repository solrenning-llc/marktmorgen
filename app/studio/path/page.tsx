import {PathCertificates} from "@/components/path-certificates";
import {PathWeeklySummary} from "@/components/path-weekly-summary";
import {pathWeeklySummary} from "@/lib/path-weekly-summary";
import {PathAiWording} from "@/components/path-ai-wording";
import {aiAvailableFor} from "@/lib/ai";
import {currentWordingSource} from "@/lib/path-wording-source";
import {PathSocialScripts} from "@/components/path-social-scripts";
import {pathScriptProducts} from "@/lib/path-scripts";
import {RETURN_HEADING} from "@/lib/path-return-rules";
import {PathGrowthMissions} from "@/components/path-growth-missions";
import {readPathGrowth} from "@/lib/path-growth-facts";
import {pathGrowthMissions} from "@/lib/path-growth-rules";
import { PathBoard } from "@/components/path-board";
import { readPathBoardRows } from "@/lib/path-board";
import { PathCheckoutNotice } from "@/components/path-checkout-notice";
import { pathCheckoutNotice } from "@/lib/path-checkout";
import { PLANS_ON_SALE } from "@/lib/opening";
import { canSell } from "@/lib/store-checkout";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { pathCampaign } from "@/lib/path-campaign";
import { PathMissions } from "@/components/path-missions";
import { PathReminderButton } from "@/components/path-reminder-button";
import { PathShareCard } from "@/components/path-share-card";
import { PathMilestone } from "@/components/path-milestone";
import { pathShare } from "@/lib/path-share";
import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { pathPlanLine } from "@/lib/path-plan";
import { largerPlanFor } from "@/lib/larger-plan";
import { chargeStudio, readPath, visitPath,returnMissionFor } from "@/lib/path";
import { KEPT_CHECKINS, LEVEL_NAMES, LEVELS, PATH_SLOGAN, PATH_TITLE, goalWords, localDay, pathProgress, streakOf, validPathDay, type Place } from "@/lib/path-rules";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PathOnboarding } from "@/components/path-onboarding";
export const metadata: Metadata={title:"Your Path — Marktmorgen",robots:{index:false,follow:false}};
export default async function PathPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const query=await searchParams;
 const found=await studioView(await cookies(),typeof query.store==="string"?query.store:undefined,"settings");
 if(!found.ok) redirect(found.reason==="signed_out"?"/signin":"/studio");
 const access=found.view;const store=access.store;
 if(access.role!=="owner")redirect(studioPath(store,"team=forbidden"));
 const now=new Date().getTime();
 const checkout=pathCheckoutNotice({plansOpen:PLANS_ON_SALE,suspended:Boolean(store.suspended),checkoutReady:canSell(store),testMode:sellsInTestMode(store)});
 const reading=await readPath(store).then(record=>({record,failed:false})).catch(()=>({record:null,failed:true}));
 const saved=reading.record;
 const result=saved?await visitPath(store,saved,now).then(value=>({value,failed:false})).catch(()=>({value:null,failed:true})):null;
 const visited=result?.value;
 const failed=reading.failed || result?.failed;
 const record=visited?.record || saved;
 const progress=visited && record?pathProgress(visited.facts,record.answers,record.startedAt,now):null;
 const returnMission=record?returnMissionFor(store,record,now):null;
 const returning=returnMission?.state==="open";
 const streak=record?streakOf(record.checkins,localDay(record.answers.timeZone,now)):null;
 const weeklySummary=progress&&record&&!failed?pathWeeklySummary({timeZone:record.answers.timeZone,checkins:record.checkins},now):null;
 const boardRows=record?.board?await readPathBoardRows(record.board.token).catch(()=>null):[];
 const growth=record&&progress?.complete&&!returning?await readPathGrowth(store,record.money,chargeStudio(store)).catch(()=>null):null;
 const growthMissions=growth?pathGrowthMissions(growth.facts):[];
 const growthHref=(place:"products"|"email"|"people"|"reviews"|"numbers")=>place==="products"||place==="numbers"?studioPath(store)+"#"+place:studioPath(store,"",place);
 const larger=largerPlanFor(store,now/1000);
 // An unread count is said to be unknown on the line, and no plan is suggested from it (rule 24).
 const studioUsed=await allowanceUsedExact(store,"studio",now);
 const planLine=pathPlanLine(studioUsed,allowanceFor(store,"studio",now/1000),larger);
 const mission=returning?returnMission:progress?.today;
 const wording=record&&aiAvailableFor(store,now)?currentWordingSource(store,record,now):null;
 const campaign=returning?null:pathCampaign(progress?.today);
 // The share card (components/path-share-card.tsx) is drawn only when it has content: the milestone links to it only then.
 const shareable=Boolean(record&&progress&&pathShare({level:record.best,days:progress.dayOnPath,moneyCents:null,currency:store.currency,moneyAt:null}));
 const hrefFor=(place:Place)=>place.store?"/@"+encodeURIComponent(store.handle):studioPath(store,"",place.page || "")+(place.hash || "");
 return <div className="min-h-screen bg-paper text-ink">
  <StudioHeader current={store} role={access.role} stores={access.stores} owned={access.owned} action={{href:studioPath(store),label:"Back to the studio",short:"Studio"}}/>
  <StudioStorePin sid={store.sid}><main id="content" className="container-page break-words pb-20 pt-10">
   <p className="eyebrow">Marktmorgen Path</p><Link className="mt-3 inline-block underline" href="/platform/path">How Path works</Link><h1 className="t-h2 mt-3">{PATH_TITLE}</h1><p className="mt-3 text-ink-soft">{PATH_SLOGAN}</p>
   <PathCheckoutNotice notice={checkout} reviewHref={checkout.state==="preview"?"/mission":checkout.state==="live"?null:studioPath(store)+"#stripe"}/>
   {planLine?<aside className="notice mt-6" aria-label="Your studio usage"><p>{planLine}</p>{larger&&studioUsed!==null?<Link className="mt-2 inline-block underline" href="/pricing">Review plans</Link>:null}</aside>:null}
   {failed?<p role="alert" className="notice notice-error mt-6">Your Path could not be read just now. Please try again in a moment.</p>:null}
   {progress && record?<>
    <section className="mt-8 rounded-2xl border border-line bg-white p-6" aria-label="Your progress">
     <div className="relative mb-4 h-28 w-28" role="img" aria-label={progress.done+" of "+progress.of+" missions recorded"}>
      <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true"><circle cx="50" cy="50" r="44" fill="none" stroke="#e5e1eb" strokeWidth="6"/><circle cx="50" cy="50" r="44" fill="none" stroke="#6d28d9" strokeWidth="6" pathLength="100" strokeDasharray={(progress.done/progress.of*100)+" 100"} transform="rotate(-90 50 50)"/><path d="M28 62a22 22 0 0 1 44 0" fill="#f5b942"/><path d="M23 63h54M50 25v9M25 39l7 6M75 39l-7 6" stroke="#5b3c09" strokeWidth="3" strokeLinecap="round"/></svg>
     </div>
     <h2 className="text-xl font-semibold">{record.best>=0?LEVEL_NAMES[LEVELS[record.best]]:"Your first step is ready"}</h2>
     <p className="mt-2 text-sm text-ink-soft">{goalWords(record.answers,store.currency)}</p>
     <p className="mt-2 text-sm text-ink-soft">Progress comes from your store&apos;s records. Readings refresh at most once every ten minutes when your studio allowance has room.</p>
     <p className="mt-2 text-sm text-ink-soft">{record.counts?"Visits and leads last read: "+new Date(record.counts.at).toISOString()+".":"Visits and leads have not been read yet."} {record.money?"Orders last read: "+new Date(record.money.at).toISOString()+".":"Orders have not been read yet."}</p>
     {!failed&&!returning&&weeklySummary?.state==="unavailable"&&streak&&record.checkins.length<=KEPT_CHECKINS&&Array.from(record.checkins).every(validPathDay)?<p className="mt-2">Current streak: {streak.days} check-in {streak.days===1?"day":"days"}. {streak.restLeft} rest {streak.restLeft===1?"day":"days"} left this week.</p>:null}
    </section>
    {!failed&&!returning?<PathMilestone sid={store.sid} done={[...progress.days,...progress.traffic].filter(m=>m.state==="done").map(m=>({id:m.id,title:m.title}))} shareHref={shareable?"#path-share-title":null}/>:null}
    {!failed&&weeklySummary?<PathWeeklySummary summary={weeklySummary} streak={returning?null:streak}/>:null}
    <section className="mt-8" aria-labelledby="path-next"><h2 id="path-next" className="t-h3">{returning?RETURN_HEADING:progress.complete?"Your first real sale is recorded":"Your next mission"}</h2>
     {mission?<div className="mt-4 rounded-2xl border border-line bg-white p-6"><h3 className="text-xl font-semibold">{mission.title}</h3><p className="mt-3">{mission.why}</p><ol className="mt-4 list-decimal space-y-2 pl-6">{mission.steps.map(step=><li key={step}>{step}</li>)}</ol><p className="mt-4 text-sm text-ink-soft">Recorded when: {mission.closesOn}</p><a className="btn btn-primary mt-5" href={hrefFor(mission.place)}>{mission.place.label}</a></div>:<p className="mt-3">Keep listening to your customers and improving what you offer. Your reached level stays with you.</p>}
     {wording?<PathAiWording key={store.sid+"|"+wording.mission+"|"+wording.step} source={wording} endpoint={"/api/store/path?store="+encodeURIComponent(store.sid)}/>:null}
     {campaign?<aside className="mt-4 rounded-xl border border-line bg-white p-5" aria-label="Campaigns for this mission"><p>{campaign.why}</p><a className="btn mt-4" href={studioPath(store,"campaignGoal="+campaign.goal,"funnels")+"#campaign-starters"}>Explore campaigns for this mission</a><p className="mt-3 text-sm text-ink-soft">Browsing does not create anything or use your preview allowance. Choose a campaign, review its requirements and adapt it to your own offer.</p></aside>:null}
    </section>
    {!returning?<><PathGrowthMissions missions={growthMissions} hrefFor={growthHref} read={Boolean(growth?.read)} moneyAt={record.money?.at??null}/>
    <PathMissions missions={[...progress.days,...progress.traffic]} hrefFor={hrefFor}/>
    <PathSocialScripts products={pathScriptProducts(store)} answers={{audience:record.answers.audience,minutes:record.answers.minutes}} productsHref={studioPath(store)+"#products"}/></>:null}
    <PathBoard key={record.board?.token || "not-joined"} joined={Boolean(record.board)} alias={record.board?"Creator "+record.board.token.slice(0,12):null} rows={boardRows} privacyHref={studioPath(store,"","path/privacy")}/>
    <PathReminderButton phoneUrl={studioPath(store,"","phone")}/>
    <PathCertificates key={store.sid+"|"+record.best+"|"+record.bestAt} input={{level:record.best,recordedAt:record.bestAt,days:progress.dayOnPath,moneyCents:record.money?.currency===store.currency?record.money.cents:null,currency:store.currency,moneyAt:record.money?.at || null}}/><PathShareCard input={{level:record.best,days:progress.dayOnPath,moneyCents:record.money?.currency===store.currency?record.money.cents:null,currency:store.currency,moneyAt:record.money?.at || null}}/>
    <details className="mt-8"><summary className="cursor-pointer py-3 font-semibold">Your answers and privacy</summary><PathOnboarding currency={store.currency} answers={record.answers}/></details>
   </>:!failed?<PathOnboarding currency={store.currency}/>:null}
  </main></StudioStorePin>
 </div>;
}
