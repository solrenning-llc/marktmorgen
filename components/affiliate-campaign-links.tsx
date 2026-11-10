"use client";

import { useId, useState } from "react";
import { SharePanel } from "@/components/share-panel";
import { affiliateToolWords } from "@/lib/buyer-words/affiliate-tools";
import type { LanguageCode } from "@/lib/store-language";

/** How many products the affiliate page loads for this panel (app/[handle]/affiliates, kitProducts). */
const MOST_PRODUCTS = 60;

export function AffiliateCampaignLinks({ products, language }: { products: { id: string; title: string; url: string }[]; language?: LanguageCode }) {
  const id=useId();
  const [selected,setSelected]=useState("");
  const t=affiliateToolWords(language);
  const product=products.find(item=>item.id===selected)??products[0];
  if(!product)return null;
  return <details className="mt-6 rounded-xl border p-4" style={{borderColor:"var(--st-line)"}}>
    <summary className="cursor-pointer text-sm font-semibold">{t.linksSummary}</summary>
    <p className="st-muted mt-2 text-sm">{t.linksIntro}</p>
    <label htmlFor={id} className="st-label mt-3">{t.product}<select id={id} className="field mt-1 w-full" value={product.id} onChange={event=>setSelected(event.target.value)}>{products.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <p className="st-muted mb-3 mt-1 text-xs">{t.productsLoaded(MOST_PRODUCTS)}</p>
    <SharePanel key={product.id} url={product.url} title={t.shareTitle(product.title)} what="affiliate product" />
  </details>;
}
