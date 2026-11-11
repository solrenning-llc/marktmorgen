"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import type { StatsData } from "@/lib/stats";
import { promotionChoices, promotionLink, promotionMedium, type PromotionProduct, type PromotionWindow } from "@/lib/promotion-plan";
import { CAMPAIGN_MEDIA, POST_PLACES, type CampaignMedium } from "@/lib/share-links";
import { formatMoney } from "@/lib/money";
import { channelName } from "@/lib/channel-names";
import { copyCampaignLink } from "@/lib/campaign-copy";

/**
 * `campaignResults`: whether the "Campaigns, payments and recorded ads" panel is on the page (hasCampaignResults,
 * lib/campaign-results.ts). Without it there is nothing for "See campaign results" to go to, so it is not offered (VR).
 */
export function PromotionPlanner({ data, range, products, campaignResults }: { data: StatsData; range: PromotionWindow; products: PromotionProduct[]; campaignResults: boolean }) {
  const id = useId();
  const plan = promotionChoices(data, range, products);
  const [selected, setSelected] = useState("");
  const [source, setSource] = useState("");
  const [campaign, setCampaign] = useState("promotion-" + (data.days.at(-1)?.date ?? range));
  const [mediumOverride, setMediumOverride] = useState<CampaignMedium | null>(null);
  const [variant, setVariant] = useState("");
  const [copied, setCopied] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  const copyRequest = useRef(0);
  const product = plan.products.find(item => item.id === selected) ?? plan.products[0];
  const channel = source || plan.channel;
  const medium = promotionMedium(channel, mediumOverride);
  const link = product ? promotionLink(product, channel, campaign, medium, variant) : "";
  if (!product) return null;
  async function copy() {
    if (!link) return;
    const request = ++copyRequest.current;
    const result = await copyCampaignLink(link, () => request === copyRequest.current ? linkInput.current : null, text => navigator.clipboard.writeText(text));
    if (request !== copyRequest.current || result === "stale" || linkInput.current?.value !== link) return;
    setCopied(result === "copied" ? link : result === "selected" ? "selected:" + link : "failed:" + link);
  }
  return <section className="mt-5 min-w-0 rounded-[16px] bg-gradient-to-br from-violet-50 to-emerald-50 p-4 ring-1 ring-line" aria-labelledby={id + "-title"}>
    <h3 id={id + "-title"} className="text-sm font-bold text-ink">Prepare your next promotion</h3>
    <p className="mt-1 text-sm text-ink-soft">Choose a product and copy a campaign link without leaving your numbers. Nothing is posted or sent for you.</p>
    <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-xs font-semibold text-ink-soft" htmlFor={id + "-product"}>Product
        <span className="relative mt-1 block min-w-0"><select id={id + "-product"} className="field overflow-hidden w-full min-w-0 max-w-full appearance-none pr-10" value={product.id} onChange={event => { setSelected(event.target.value); copyRequest.current += 1; setCopied(""); }}>
          {plan.products.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select><Icon name="chevron-down" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink" /></span>
      </label>
      <label className="min-w-0 text-xs font-semibold text-ink-soft" htmlFor={id + "-channel"}>Where you will share it
        <span className="relative mt-1 block min-w-0"><select id={id + "-channel"} className="field overflow-hidden w-full min-w-0 max-w-full appearance-none pr-10" value={channel} onChange={event => { setSource(event.target.value); copyRequest.current += 1; setCopied(""); }}>
          {POST_PLACES.map(place => <option key={place.place} value={place.place}>{place.label}</option>)}
        </select><Icon name="chevron-down" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink" /></span>
      </label>
    </div>
    <p className="mt-2 text-xs text-ink-soft">{plan.known ? "Products are ordered by recorded gross revenue, then page views." : "Paid figures are unavailable. Products are ordered by page views."} This list includes up to 50 published products with recorded activity, not your entire catalog.</p>
    <p className="mt-1 text-xs text-ink-soft">{product.figures ? <>
      {product.figures.views.toLocaleString("en-US")} page views
      {plan.known ? " · " + formatMoney(product.figures.cents, data.currency) + " gross revenue" : ""} in the selected period.
    </> : "No product figures are available in this period."} {plan.channelEvidence ? <>The suggested channel, {channelName(plan.channel)}, is based on store-wide {plan.channelBasis === "sales" ? "gross revenue" : "visits"}; it does not prove this product sold through that channel.</> : "No channel is suggested by measured results; Instagram is the editable starting choice."}</p>
    <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-xs font-semibold text-ink-soft" htmlFor={id + "-campaign"}>Campaign name
        <input id={id + "-campaign"} className="field mt-1 w-full min-w-0 max-w-full" maxLength={60} value={campaign} onChange={event => { setCampaign(event.target.value); copyRequest.current += 1; setCopied(""); }} />
      </label>
      <label className="min-w-0 text-xs font-semibold text-ink-soft" htmlFor={id + "-medium"}>Promotion type
        <span className="relative mt-1 block min-w-0"><select id={id + "-medium"} className="field overflow-hidden w-full min-w-0 max-w-full appearance-none pr-10" value={medium} onChange={event => { setMediumOverride(event.target.value as CampaignMedium); copyRequest.current += 1; setCopied(""); }}>
          {CAMPAIGN_MEDIA.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select><Icon name="chevron-down" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink" /></span>
      </label>
      <label className="min-w-0 text-xs font-semibold text-ink-soft" htmlFor={id + "-variant"}>Post or ad variant (optional)
        <input id={id + "-variant"} className="field mt-1 w-full min-w-0 max-w-full" maxLength={60} value={variant} onChange={event => { setVariant(event.target.value); copyRequest.current += 1; setCopied(""); }} />
      </label>
    </div>
    <label className="mt-3 block text-xs font-semibold text-ink-soft" htmlFor={id + "-link"}>Your campaign link
      <input ref={linkInput} id={id + "-link"} aria-describedby={id + "-copy-status"} className="field mt-1 w-full min-w-0 max-w-full" readOnly value={link} onFocus={event => event.currentTarget.select()} />
    </label>
    {!link ? <p className="mt-1 text-xs text-ink-soft">Enter a campaign name with letters or numbers to create the link.</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="btn btn-primary" disabled={!link} onClick={() => void copy()}>Copy campaign link</button>
      {campaignResults ? <button type="button" className="btn btn-secondary" onClick={() => document.getElementById("numbers-posts")?.scrollIntoView({ behavior: "smooth", block: "start" })}>See campaign results</button> : null}
    </div>
    <p id={id + "-copy-status"} className="mt-2 text-xs text-ink-soft" role="status">{copied === link && link ? "Campaign link copied." : copied === "selected:" + link ? "The campaign link is selected. Copy it using your keyboard or device menu." : copied === "failed:" + link ? "Select the campaign link above and copy it." : "Share this link, then review its recorded visits and payments in Campaigns. Results are not guaranteed; gross revenue excludes refunds, fees and other costs."}</p>
  </section>;
}
