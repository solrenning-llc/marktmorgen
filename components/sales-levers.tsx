import Link from "next/link";
import type {Store} from "@/lib/store";
import {salesLeverSettings,type LeverReading} from "@/lib/sales-levers";
import {leverEarnedWords} from "@/lib/lever-earnings";
import {studioPath} from "@/lib/studio-route";
/** Uses the studio's already loaded store and financial reading. No side effects. */
export function SalesLevers({store,reading,canConfigure}:{store:Store;reading:LeverReading|null;canConfigure:boolean}){
 const levers=salesLeverSettings(store);
 return <section id="grow-your-sales" aria-labelledby="sales-levers-title" className="card mt-8 scroll-mt-32 p-5 sm:p-8" data-sales-levers>
 <h2 id="sales-levers-title" className="text-xl font-semibold">Grow your sales</h2>
 <p className="mt-3 text-ink-soft">Review the tools and evidence your store already has. These are recorded gross payments, before refunds, fees, taxes and other costs; they do not measure incremental profit or prove an offer caused a sale. Rows can overlap and must not be added together.</p>
 <p className="mt-3 text-sm text-ink-soft">{reading?"Reading: "+reading.from+" to "+reading.asOf+" · "+reading.currency.toUpperCase()+".":"Payment evidence is unavailable; amounts remain unknown."}{reading&&!reading.complete?" The payment reading is incomplete; no amount is certified.":""}</p>
 <ul className="mt-6 grid gap-5 md:grid-cols-2">{levers.map(lever=>{const metric=reading?.rows[lever.key];return <li key={lever.key} className="rounded-2xl border border-line p-5">
 <h3 className="text-lg font-semibold">{lever.title}</h3><p className="mt-2 text-sm font-semibold text-violet-deep">{lever.state}</p>
 <p className="mt-3 text-sm font-semibold">{leverEarnedWords(metric,lever.key,reading?.complete===true).line}</p>
 <p className="mt-2 text-sm text-ink-soft">{leverEarnedWords(metric,lever.key,reading?.complete===true).how}</p><p className="mt-3 text-sm text-ink-soft">{lever.cost}</p>
 {canConfigure?<Link href={lever.path.startsWith("#")?lever.path:studioPath(store,"",lever.path)} prefetch={false} className="link mt-3 inline-flex min-h-11 items-center">Review {lever.title.toLowerCase()} settings</Link>:null}
 </li>;})}</ul>
 <p className="mt-5 text-sm text-ink-soft">Cost-free optional offer mechanisms remain available when configured; empty offers cannot be enabled without your product choices. Existing opt-outs and permissions are preserved. This review changes no settings, sends no message and opens no sale.</p>
 </section>;
}
