import type { StatsData } from "@/lib/stats";
import { spendWithin, type AdSpend } from "@/lib/ad-spend-rules";
export type CampaignResultRow = { campaign: string; paymentChannels: string[] | null; adChannels: string[] | null; visits: number; paidRecords: number | null; gross: number | null; ads: number | null; grossLessAds: number | null };
export type CampaignResults = { from: string; to: string; partial: boolean; salesKnown: boolean; unassignedAds: number | null; rows: CampaignResultRow[] };
/** Campaign tags aggregate visits and paid records across channels, without guessing a traffic-channel split. */
/** Whether the "Campaigns, payments and recorded ads" panel is drawn: a campaign or an ad not tied to one was recorded. */
export function hasCampaignResults(report: CampaignResults | null): report is CampaignResults {
  return Boolean(report && (report.rows.length || report.unassignedAds));
}

export function campaignResultsFrom(data: Pick<StatsData, "sales" | "partial" | "posts" | "days">, range: "d7" | "d30" | "d90", spends?: AdSpend[]): CampaignResults | null {
  const days = (data.days ?? []).slice(-(range === "d7" ? 7 : range === "d30" ? 30 : 90));
  if (!days.length) return null;
  const from = days[0].date, to = days[days.length - 1].date;
  const known = data.sales === "ok" && !data.partial;
  const rows = new Map<string, CampaignResultRow>();
  for (const post of data.posts?.[range] ?? []) {
    rows.set(post.campaign, { campaign: post.campaign, paymentChannels: known ? post.sales === 0 ? [] : post.sources ?? null : null, adChannels: spends === undefined ? null : [], visits: post.visits,
      paidRecords: known ? post.sales : null, gross: known ? post.cents : null, ads: spends === undefined ? null : 0, grossLessAds: null });
  }
  let unassignedAds: number | null = spends === undefined ? null : 0;
  for (const entry of spends ?? []) {
    const cents = spendWithin(entry, from, to);
    if (!cents) continue;
    if (!entry.campaign) { unassignedAds = (unassignedAds ?? 0) + cents; continue; }
    const row = rows.get(entry.campaign) ?? { campaign: entry.campaign, paymentChannels: known ? [] : null, adChannels: [], visits: 0, paidRecords: known ? 0 : null, gross: known ? 0 : null, ads: 0, grossLessAds: null };
    row.ads = (row.ads ?? 0) + cents;
    row.adChannels = [...new Set([...(row.adChannels ?? []), entry.channel])].sort();
    rows.set(entry.campaign, row);
  }
  for (const row of rows.values()) row.grossLessAds = row.gross === null || row.ads === null ? null : row.gross - row.ads;
  return { from, to, partial: data.partial === true, salesKnown: known, unassignedAds,
    rows: [...rows.values()].sort((a,b) => (b.ads ?? 0) - (a.ads ?? 0) || (b.gross ?? 0) - (a.gross ?? 0) || b.visits - a.visits || a.campaign.localeCompare(b.campaign)) };
}
