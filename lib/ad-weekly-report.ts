/**
 * The weekly ads report: 632 [AA2] (p) (owner, 2 November 2026, 02h18
 * Fortaleza: "Relatório semanal automático dos anúncios por e-mail e no
 * estúdio, só com números medidos, sem pixel de abertura").
 *
 * Only the words and the table, from the week's measured figures in
 * lib/campaign-results.ts (recorded ad spend, sales and their amount) and the
 * two measures the caller has or has not: refunds and disputes matched to
 * each campaign, and the days each campaign took to pay back. Pure: nothing
 * is read, sent or kept here; sending (the Codex lane, SES) and the weekly job
 * (app/api/cron/weekly) come later and add nothing to these words.
 *
 * Its rules:
 *   - a figure that was not measured reads "unknown", never 0, and the week
 *     then says it is partial and which measure is missing;
 *   - no picture, no link and no address at all, so nothing can track an open
 *     or a click; a table, never a chart, with a plain-text version that holds
 *     the same cells and the same sentences;
 *   - only campaign tags and sums: a tag that could hold a person's address
 *     or number is shown as a neutral label, and no buyer is ever named;
 *   - no forecast and no promise: the figures are before fees, tax and the
 *     creator's own costs, and a tagged sale does not prove the ad caused it.
 */
import type { CampaignResults } from "@/lib/campaign-results";
import { CAMPAIGN_TAG_MAX } from "@/lib/came-from";
import { formatMoney } from "@/lib/money";

/** Refunds and disputes made in the week on the sales of one campaign: how many, and their amount. */
export type TakenBack = { count: number; cents: number };

export type WeeklyAdReportInput = {
  /** campaignResultsFrom(data, "d7", spends): null when the week could not be read. */
  results: CampaignResults | null;
  currency: string;
  /** By campaign tag; a campaign missing here has unknown refunds and disputes. */
  takenBack?: Readonly<Record<string, TakenBack>>;
  /** By campaign tag: whole days until what was left after refunds and disputes reached the ad spend, or "not_yet"; missing is unknown. */
  payback?: Readonly<Record<string, number | "not_yet">>;
};

export type WeeklyAdRow = {
  campaign: string;
  spend: number | null;
  sales: number | null;
  gross: number | null;
  takenBack: TakenBack | null;
  afterTakenBack: number | null;
  /** Ad spend over the sales kept, rounded up; words when there is nothing to divide. */
  costPerSale: number | "no_spend" | "no_sales" | null;
  payback: number | "not_yet" | "no_spend" | null;
};

export type WeeklyAdReport = {
  measurement: "complete" | "partial" | "none";
  from: string | null;
  to: string | null;
  rows: WeeklyAdRow[];
  unassignedAds: number | null;
  totals: { spend: number | null; sales: number | null; afterTakenBack: number | null; costPerSale: number | "no_spend" | "no_sales" | null };
  subject: string;
  html: string;
  text: string;
};

export const WEEKLY_AD_COLUMNS = ["Campaign", "Recorded ad spend", "Sales", "Amount from sales", "Refunds and disputes", "Left after refunds and disputes", "Cost per sale kept", "Days to pay back"] as const;

/** At most this many campaigns are listed; the rest are counted and still in the totals. */
export const WEEKLY_AD_MAX_ROWS = 25;

const UNKNOWN = "unknown";
const LINE = 80;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATES = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const count = (n: unknown): number | null => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);
const takenBackOf = (raw: unknown): TakenBack | null => {
  if (!raw || typeof raw !== "object") return null;
  const { count: c, cents } = raw as TakenBack;
  return count(c) === null || count(cents) === null ? null : { count: c, cents };
};
const own = <T,>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

function dateOf(day: string): string {
  if (!DAY.test(day)) return "an unknown day";
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day ? DATES.format(at) : "an unknown day";
}

/** A tag as the numbers count it, up to the length the store keeps; anything else, or a number that could be a phone number, is not shown. */
const SHOWN_TAG = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${CAMPAIGN_TAG_MAX - 1}}$`);
/** A real date written year, month, day (2026-11-27, 2026.11.27): four, two and two digits, never a phone number. */
const DATE_IN_TAG = /(^|\D)(?:19|20)\d{2}[._-](?:0[1-9]|1[0-2])[._-](?:0[1-9]|[12]\d|3[01])(?!\d)/g;
/** Seven digits or more, together or split by dots, dashes or underscores (555-201-4477, 1-202-555-0100, 202.555.0100). */
const NUMBER_IN_TAG = /\d(?:[._-]?\d){6,}/;
const phoneLike = (tag: string) => NUMBER_IN_TAG.test(tag.replace(DATE_IN_TAG, "$1x"));
const shownTag = (tag: unknown): tag is string => typeof tag === "string" && SHOWN_TAG.test(tag) && !phoneLike(tag);

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function wrap(paragraph: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > LINE) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function costPerSale(spend: number | null, sales: number | null, back: TakenBack | null): WeeklyAdRow["costPerSale"] {
  if (spend === null || sales === null || back === null) return null;
  if (spend === 0) return "no_spend";
  const kept = sales - back.count;
  return kept > 0 ? Math.ceil(spend / kept) : "no_sales";
}

function rowOf(row: CampaignResults["rows"][number], label: string, input: WeeklyAdReportInput, salesKnown: boolean): WeeklyAdRow {
  const spend = count(row.ads);
  const sales = salesKnown ? count(row.paidRecords) : null;
  const gross = salesKnown ? count(row.gross) : null;
  const back = sales === null ? null : takenBackOf(own(input.takenBack, row.campaign));
  const afterTakenBack = gross === null || back === null ? null : gross - back.cents;
  const told = own(input.payback, row.campaign);
  const payback: WeeklyAdRow["payback"] = spend === null || sales === null ? null : spend === 0 ? "no_spend"
    : told === "not_yet" ? "not_yet" : Number.isSafeInteger(told) && (told as number) >= 1 ? (told as number) : null;
  return { campaign: label, spend, sales, gross, takenBack: back, afterTakenBack, costPerSale: costPerSale(spend, sales, back), payback };
}

/** The cells of one row, in WEEKLY_AD_COLUMNS order, as both versions show them. */
function cellsOf(row: WeeklyAdRow, currency: string): string[] {
  const money = (n: number | null) => (n === null ? UNKNOWN : formatMoney(n, currency));
  const back = row.takenBack === null ? UNKNOWN : row.takenBack.count === 0 && row.takenBack.cents === 0 ? "None" : `${row.takenBack.count} for ${formatMoney(row.takenBack.cents, currency)}`;
  const cost = row.costPerSale === null ? UNKNOWN : row.costPerSale === "no_spend" ? "No ad spend recorded" : row.costPerSale === "no_sales" ? "No sales kept" : formatMoney(row.costPerSale, currency);
  const payback = row.payback === null ? UNKNOWN : row.payback === "no_spend" ? "No ad spend recorded" : row.payback === "not_yet" ? "Not yet" : `${row.payback} ${row.payback === 1 ? "day" : "days"}`;
  return [row.campaign, money(row.spend), row.sales === null ? UNKNOWN : String(row.sales), money(row.gross), back, money(row.afterTakenBack), cost, payback];
}

const sum = (values: (number | null)[]): number | null => values.reduce<number | null>((total, v) => (total === null || v === null ? null : total + v), 0);

function render(subject: string, before: string[], table: { caption: string; rows: string[][] } | null, after: string[]): { html: string; text: string } {
  const p = (s: string) => `<p>${escape(s)}</p>`;
  let html = `<section lang="en-US"><h2>${escape(subject)}</h2>${before.map(p).join("")}`;
  const text: string[] = [subject, ...before.map(wrap)];
  if (table) {
    html += `<table><caption>${escape(table.caption)}</caption><thead><tr>${WEEKLY_AD_COLUMNS.map((c) => `<th scope="col">${escape(c)}</th>`).join("")}</tr></thead><tbody>`;
    html += table.rows.map(([name, ...cells]) => `<tr><th scope="row">${escape(name)}</th>${cells.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`).join("");
    html += "</tbody></table>";
    text.push(wrap(table.caption), ...table.rows.map(([name, ...cells]) => [`Campaign: ${name}`, ...cells.map((c, i) => `  ${WEEKLY_AD_COLUMNS[i + 1]}: ${c}`)].join("\n")));
  }
  html += `${after.map(p).join("")}</section>`;
  text.push(...after.map(wrap));
  return { html, text: `${text.join("\n\n")}\n` };
}

const NOT_PROFIT = "These are measured figures only, before payment fees, tax and your own costs. They are not profit and not a forecast. A sale with a campaign tag does not prove that the ad caused it.";
const MEANINGS = "Cost per sale kept is the recorded ad spend divided by the sales left after refunds and disputes. Days to pay back count from the first day of ad spend until the amount left after refunds and disputes reached the ad spend.";

/** The week's report, in HTML and in plain text, from measured figures only. */
export function weeklyAdReport(input: WeeklyAdReportInput): WeeklyAdReport {
  const results = input.results;
  const currency = input.currency;
  if (!results || !Array.isArray(results.rows)) {
    const subject = "Your ads this week";
    const words = ["The figures for your ads this week could not be read. Nothing is shown here rather than a guess. Numbers in your studio shows them once they can be read."];
    return { measurement: "none", from: null, to: null, rows: [], unassignedAds: null, totals: { spend: null, sales: null, afterTakenBack: null, costPerSale: null }, subject, ...render(subject, words, null, []) };
  }
  const salesKnown = results.salesKnown === true && results.partial !== true;
  let hidden = 0;
  const rows = results.rows.map((row) => rowOf(row, shownTag(row.campaign) ? row.campaign : `Campaign tag not shown (${++hidden})`, input, salesKnown));
  const unassignedAds = count(results.unassignedAds);
  const from = dateOf(results.from), to = dateOf(results.to);
  const subject = `Your ads from ${from} to ${to}`;

  const spend = sum([...rows.map((r) => r.spend), unassignedAds]);
  // Unread sales are unknown in the totals too, even with no campaign row to carry the unknown.
  const sales = salesKnown ? sum(rows.map((r) => r.sales)) : null;
  const kept = salesKnown ? sum(rows.map((r) => (r.sales === null || r.takenBack === null ? null : r.sales - r.takenBack.count))) : null;
  const afterTakenBack = salesKnown ? sum(rows.map((r) => r.afterTakenBack)) : null;
  const totalCost = spend === null || kept === null ? null : spend === 0 ? "no_spend" : kept > 0 ? Math.ceil(spend / kept) : "no_sales";

  const missing: string[] = [];
  if (results.partial === true) missing.push("Some payments were not read yet.");
  else if (!salesKnown) missing.push("Sales could not be read in full.");
  if (unassignedAds === null || rows.some((r) => r.spend === null)) missing.push("Ad spend was not read.");
  if (rows.some((r) => r.sales !== null && r.takenBack === null)) missing.push("Refunds and disputes are not matched to each campaign yet.");
  if (rows.some((r) => r.spend !== null && r.sales !== null && r.payback === null)) missing.push("Days to pay back were not measured for every campaign.");
  const complete = missing.length === 0 && rows.every((r) => cellsOf(r, currency).every((c) => c !== UNKNOWN));

  const money = (n: number | null) => (n === null ? UNKNOWN : formatMoney(n, currency));
  const before = [`These are the measured figures of your ads by campaign, from ${from} to ${to}.`];
  if (!complete) before.push(`Partial: some figures for these days were not measured, so they show as unknown, not as zero. ${missing.join(" ")}`.trim());
  before.push(`Recorded ad spend in all: ${money(spend)}. Ads with no campaign tag: ${money(unassignedAds)}.`);
  before.push(`Left after refunds and disputes in all: ${money(afterTakenBack)}. Cost per sale kept, all ads: ${totalCost === null ? UNKNOWN : totalCost === "no_spend" ? "no ad spend recorded" : totalCost === "no_sales" ? "no sales kept" : formatMoney(totalCost, currency)}.`);
  if (!rows.length) {
    if (salesKnown && unassignedAds !== null) before.push("No campaign had recorded ad spend or tagged sales on these days.");
    else if (unassignedAds !== null) before.push("No campaign had recorded ad spend on these days. Its tagged sales could not be read, so they are unknown.");
    else if (salesKnown) before.push("No campaign had tagged sales on these days. Its ad spend could not be read, so it is unknown.");
    else before.push("No campaign can be listed for these days, because neither ad spend nor sales could be read.");
  }

  const listed = rows.slice(0, WEEKLY_AD_MAX_ROWS);
  const after: string[] = [];
  const more = rows.length - listed.length;
  if (more > 0) after.push(`${more} more ${more === 1 ? "campaign is" : "campaigns are"} not listed here. Numbers in your studio lists all of them; the amounts in all above count every campaign.`);
  after.push(MEANINGS, NOT_PROFIT);
  const table = listed.length ? { caption: `Ads by campaign, ${from} to ${to}`, rows: listed.map((r) => cellsOf(r, currency)) } : null;

  return { measurement: complete ? "complete" : "partial", from: results.from, to: results.to, rows, unassignedAds,
    totals: { spend, sales, afterTakenBack, costPerSale: totalCost }, subject, ...render(subject, before, table, after) };
}
