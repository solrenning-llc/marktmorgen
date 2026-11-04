import { campaignLink, postName, type CampaignMedium } from "@/lib/share-links";
import { AFFILIATE_CODE_PATTERN } from "@/lib/affiliate-setting";

export type AffiliatePromotion = { source: string; campaign: string; content: string };
/** Campaign labels only. No buyer identifier, cookie or journey is created. */
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, max) : "";
export function readAffiliatePromotion(value: unknown): AffiliatePromotion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const tags = { source: clean(raw.source,30), campaign: clean(raw.campaign,40), content: clean(raw.content,40) };
  return tags.source || tags.campaign || tags.content ? tags : null;
}
export function affiliatePromotionFrom(meta: Record<string, unknown> | null | undefined): AffiliatePromotion | null {
  if (!meta) return null;
  // Keep a single attribution family together: do not invent a pairing of current and earlier tags.
  const direct = Boolean(meta.utm_source || meta.utm_campaign || meta.utm_content);
  return readAffiliatePromotion(direct
    ? { source: meta.utm_source, campaign: meta.utm_campaign, content: meta.utm_content }
    : { source: meta.channel, campaign: meta.channel_campaign, content: meta.channel_content });
}
export function affiliateCampaignLink(url: string, code: string, source: string, campaign: string, medium: CampaignMedium = "post", content = ""): string {
  if (!AFFILIATE_CODE_PATTERN.test(code) || !postName(campaign)) return "";
  let address: URL;
  try { address = new URL(url); } catch { return ""; }
  if (address.protocol !== "https:") return "";
  address.searchParams.set("via",code);
  return campaignLink(address.toString(),source,campaign,medium,content);
}

export type PromotionLine = { ref: string; currency: string; base: number; commission: number; how: string; self: boolean; promotion?: AffiliatePromotion | null };
/** Separate currencies and tagged variants; derived bonus/second-tier lines are not additional purchases. */
export function affiliatePromotionRows(lines: PromotionLine[]) {
  const groups = new Map<string, { promotion: AffiliatePromotion | null; currency: string; paidRecords: number; base: number; commission: number }>();
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.self || !["click","code","buyer","contact","recurring"].includes(line.how)) continue;
    const identity = JSON.stringify([line.ref,line.currency]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const promotion = readAffiliatePromotion(line.promotion);
    const key = JSON.stringify([line.currency,promotion?.source??"",promotion?.campaign??"",promotion?.content??""]);
    const group = groups.get(key) ?? { promotion,currency:line.currency,paidRecords:0,base:0,commission:0 };
    group.paidRecords += 1; group.base += line.base; group.commission += line.commission;groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>b.commission-a.commission || b.paidRecords-a.paidRecords || a.currency.localeCompare(b.currency));
}
