import Link from "next/link";
import type {Store} from "@/lib/store";
import {leverStateText,salesLeverSettings,type LeverReading} from "@/lib/sales-levers";
import {leverToggle} from "@/lib/sales-lever-toggle-rules";
import {assistantWindow,type AssistantPlan} from "@/lib/store-assistant-rules";
import type {Role} from "@/lib/team-roles";
import {formatMoney} from "@/lib/money";
import {studioPath} from "@/lib/studio-route";
import {SalesLeverSwitch} from "@/components/sales-lever-switch";
/** Whether the Store assistant add-on is paid for now, from the record as loaded: a month that ran out without being read again is unknown, never active. */
export function addOnFact(plan:AssistantPlan|null,nowSeconds=Date.now()/1000):boolean|"unknown"{
 if(!plan||!plan.active||plan.disputedAt)return false;
 return assistantWindow(plan,nowSeconds)?true:"unknown";
}
/** Uses the studio's already loaded store and financial reading. Switching a lever here goes through its own settings route (components/sales-lever-switch.tsx); nothing else on it writes. */
export function SalesLevers({store,reading,canConfigure,role,addOn}:{store:Store;reading:LeverReading|null;canConfigure:boolean;role:Role;addOn:boolean|"unknown"}){
 const levers=salesLeverSettings(store);
 return <section id="grow-your-sales" aria-labelledby="sales-levers-title" className="card mt-8 scroll-mt-32 p-5 sm:p-8" data-sales-levers>
 <h2 id="sales-levers-title" className="text-xl font-semibold">Grow your sales</h2>
 <p className="mt-3 text-ink-soft">Review the tools and evidence your store already has. These are recorded gross payments, before refunds, fees, taxes and other costs; they do not measure incremental profit or prove an offer caused a sale. Rows can overlap and must not be added together.</p>
 <p className="mt-3 text-sm text-ink-soft">{reading?"Reading: "+reading.from+" to "+reading.asOf+" · "+reading.currency.toUpperCase()+".":"Payment evidence is unavailable; amounts remain unknown."}{reading&&!reading.complete?" The payment reading is incomplete; no amount is certified.":""}</p>
 <ul className="mt-6 grid gap-5 md:grid-cols-2">{levers.map(lever=>{const metric=reading?.rows[lever.key];const control=leverToggle(lever.key,{store,role,addOn});const own=lever.key==="recovery"||lever.key==="next";return <li key={lever.key} className="rounded-2xl border border-line p-5">
 <h3 className="text-lg font-semibold">{lever.title}</h3>
 {control.kind==="toggle"&&own?<SalesLeverSwitch control={control} states={{on:leverStateText(lever.key,true),off:leverStateText(lever.key,false)}}/>:<p className="mt-2 text-sm font-semibold text-violet-deep">{lever.state}</p>}
 {own&&(control.kind==="settings"||control.kind==="unknown")&&control.mayOpen?<p className="mt-2 text-sm text-ink-soft">{control.reason}</p>:null}
 <p className="mt-3 text-sm text-ink-soft">{metric?.cents!==null&&metric?.cents!==undefined?formatMoney(metric.cents,reading!.currency)+" in "+metric.records+" tagged paid records.":"Not separately measured from the available payment records."}</p>
 <p className="mt-2 text-sm text-ink-soft">{metric?.scope??"No complete payment reading is available."}</p><p className="mt-3 text-sm text-ink-soft">{lever.cost}</p>
 {canConfigure?<Link href={lever.path.startsWith("#")?lever.path:studioPath(store,"",lever.path)} prefetch={false} className="link mt-3 inline-flex min-h-11 items-center">Review {lever.title.toLowerCase()} settings</Link>:null}
 </li>;})}</ul>
 <p className="mt-5 text-sm text-ink-soft">Cost-free optional offer mechanisms remain available when configured; empty offers cannot be enabled without your product choices. Existing opt-outs and permissions are preserved. A switch on a card saves the same setting as its settings page, through the same checks; nothing else on this screen changes a setting, sends a message or opens a sale.</p>
 </section>;
}
