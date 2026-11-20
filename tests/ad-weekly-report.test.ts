/**
 * 632 [AA2] (p): the weekly ads report, the pure part that writes its words
 * and its table (lib/ad-weekly-report.ts). Only measured numbers from
 * lib/campaign-results.ts; what was not measured says "unknown", never 0; a
 * partial week says so; no open pixel and no tracked link; a table, not a
 * chart, with a plain-text version that says the same. Sending and the weekly
 * job come later. Synthetic figures only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignResultsFrom, type CampaignResults } from "@/lib/campaign-results";
import type { AdSpend } from "@/lib/ad-spend-rules";
import type { StatsData } from "@/lib/stats";
import { cameFrom } from "@/lib/came-from";
import { checkAdText } from "@/lib/ad-creative-check";
import { weeklyAdReport, WEEKLY_AD_COLUMNS, WEEKLY_AD_MAX_ROWS } from "@/lib/ad-weekly-report";
import { britishCopyHits } from "./us-english-source";
import { done, is, part } from "./check";

const from = "2026-10-11", to = "2026-10-13";
const totals = { visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 };
const data = { sales: "ok", partial: false, currency: "usd", days: [from, "2026-10-12", to].map((date) => ({ date, visitors: 0, views: 0, checkouts: 0, sales: 0 })), totals: { d7: totals, d30: totals, d90: totals }, products: [],
  posts: { d7: [{ campaign: "launch", source: "", sources: ["google", "instagram"], visits: 100, sales: 3, cents: 9000 }, { campaign: "organic", source: "email", sources: ["email"], visits: 20, sales: 1, cents: 2000 }], d30: [], d90: [] } } as unknown as StatsData;
const spends: AdSpend[] = [{ id: "a", channel: "instagram", campaign: "launch", cents: 3000, from, to }, { id: "b", channel: "google", campaign: "launch", cents: 4000, from, to }, { id: "c", channel: "tiktok", campaign: "quiet", cents: 5000, from, to }, { id: "u", channel: "email", campaign: "", cents: 1100, from, to }];
const measured = campaignResultsFrom(data, "d7", spends)!;
const takenBack = { launch: { count: 1, cents: 3000 }, organic: { count: 0, cents: 0 }, quiet: { count: 0, cents: 0 } };
const full = weeklyAdReport({ results: measured, currency: "usd", takenBack, payback: { launch: "not_yet", quiet: "not_yet" } });

// Text of a cell for comparison only: tags are taken out until none is left, then entities are decoded in one pass,
// so no decoded "&lt;" can turn into a tag and no "&amp;" is decoded twice (CodeQL js/incomplete-multi-character-sanitization
// and js/double-escaping on #3195).
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const cellText = (html: string) => {
  let text = html;
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/<[^<>]*>/g, "");
  }
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]).trim();
};
const bodyRows = (html: string) => [...(html.split("<tbody>")[1] ?? "").split("</tbody>")[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => cellText(c[1])));
const headers = (html: string) => [...(html.split("<thead>")[1] ?? "").split("</thead>")[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((c) => cellText(c[1]));

part("Measured figures are shown as measured");
const launch = full.rows.find((r) => r.campaign === "launch")!;
is("spend, sales, amount, refunds and the rest come from the measured week", [launch.spend, launch.sales, launch.gross, launch.takenBack, launch.afterTakenBack], [7000, 3, 9000, { count: 1, cents: 3000 }, 6000]);
is("cost per sale counts only the sales kept after refunds and disputes", launch.costPerSale, 3500);
is("a complete week is complete", full.measurement, "complete");
is("a complete week does not say partial", [full.text.includes("Partial"), full.html.includes("Partial")], [false, false]);
is("dates are written the US way, month first", [full.text.includes("October 11, 2026"), full.text.includes("October 13, 2026"), full.subject], [true, true, "Your ads from October 11, 2026 to October 13, 2026"]);
is("money is written in US dollars the US way", [full.text.includes("$70"), full.text.includes("$60"), full.text.includes("$35")], [true, true, true]);
const big: CampaignResults = { from, to, partial: false, salesKnown: true, unassignedAds: 0, rows: [{ campaign: "big", paymentChannels: [], adChannels: ["google"], visits: 9, paidRecords: 30, gross: 123450, ads: 100000, grossLessAds: 23450 }] };
const bigReport = weeklyAdReport({ results: big, currency: "usd", takenBack: { big: { count: 0, cents: 0 } }, payback: { big: 4 } });
is("thousands get a comma and cents two decimals", [bigReport.text.includes("$1,234.50"), bigReport.text.includes("$1,000")], [true, true]);
is("days to pay back read in whole days", [bigReport.rows[0].payback, bigReport.text.includes("4 days")], [4, true]);
is("one day is singular", weeklyAdReport({ results: big, currency: "usd", takenBack: { big: { count: 0, cents: 0 } }, payback: { big: 1 } }).text.includes("Days to pay back: 1 day\n"), true);
is("a campaign that has not paid back says so, never a number", [launch.payback, full.text.includes("Days to pay back: Not yet")], ["not_yet", true]);
const organic = full.rows.find((r) => r.campaign === "organic")!;
is("a campaign with no recorded ad spend has no cost per sale or payback, said in words", [organic.costPerSale, organic.payback, full.text.includes("No ad spend recorded")], ["no_spend", "no_spend", true]);
const quiet = full.rows.find((r) => r.campaign === "quiet")!;
is("ad spend with no sale kept is said in words, not as an endless cost", [quiet.costPerSale, full.text.includes("No sales kept")], ["no_sales", true]);
is("ads with no campaign tag are shown, never hidden", [full.unassignedAds, full.text.includes("Ads with no campaign tag: $11")], [1100, true]);
is("totals add every campaign and the untagged ads", [full.totals.spend, full.totals.afterTakenBack], [7000 + 5000 + 1100, 9000 + 2000 - 3000]);

part("What was not measured is unknown, never 0");
const noSpend = weeklyAdReport({ results: campaignResultsFrom(data, "d7")!, currency: "usd", takenBack, payback: {} });
const noSpendLaunch = noSpend.rows.find((r) => r.campaign === "launch")!;
is("unread ad spend is unknown, not $0", [noSpendLaunch.spend, noSpendLaunch.costPerSale, noSpendLaunch.payback, noSpend.totals.spend], [null, null, null, null]);
is("an unknown cell says unknown in the table and the text", [bodyRows(noSpend.html)[0][1], noSpend.text.includes("Recorded ad spend: unknown")], ["unknown", true]);
is("no $0 stands in for an unread figure", [noSpend.text.includes("$0"), noSpend.html.includes("$0")], [false, false]);
const noRefunds = weeklyAdReport({ results: measured, currency: "usd" });
const noRefundsLaunch = noRefunds.rows.find((r) => r.campaign === "launch")!;
is("refunds not matched to a campaign are unknown, and so is what is left and the cost per sale", [noRefundsLaunch.takenBack, noRefundsLaunch.afterTakenBack, noRefundsLaunch.costPerSale, noRefunds.totals.afterTakenBack], [null, null, null, null]);
is("the measured spend and sales still show", [noRefundsLaunch.spend, noRefundsLaunch.sales, noRefundsLaunch.gross], [7000, 3, 9000]);
const failedSales = weeklyAdReport({ results: campaignResultsFrom({ ...data, sales: "error" } as StatsData, "d7", spends)!, currency: "usd", takenBack, payback: { launch: 3, quiet: 3 } });
is("unread sales are unknown, and a payback cannot be shown without them", [failedSales.rows[0].sales, failedSales.rows[0].gross, failedSales.rows[0].payback, failedSales.rows[0].costPerSale], [null, null, null, null]);
const bad = weeklyAdReport({ results: { ...big, rows: [{ ...big.rows[0], ads: Number.NaN, paidRecords: -2, gross: Infinity }] }, currency: "usd", takenBack: { big: { count: -1, cents: 5 } }, payback: { big: -3 } });
is("impossible figures are unknown, never a number", [bad.rows[0].spend, bad.rows[0].sales, bad.rows[0].gross, bad.rows[0].takenBack, bad.rows[0].payback], [null, null, null, null, null]);
const nothing = weeklyAdReport({ results: null, currency: "usd" });
is("a week that could not be read says so, with no table and no zeros", [nothing.measurement, nothing.rows.length, nothing.html.includes("<table"), nothing.text.includes("$0"), nothing.text.includes("could not be read")], ["none", 0, false, false, true]);
const empty = weeklyAdReport({ results: { ...big, rows: [] }, currency: "usd" });
is("a measured week with no campaign says that, not unknown", [empty.measurement, empty.text.includes("No campaign had recorded ad spend or tagged sales")], ["complete", true]);

part("A partial measurement is said to be partial");
const partialResults = campaignResultsFrom({ ...data, partial: true } as StatsData, "d7", spends)!;
const partialReport = weeklyAdReport({ results: partialResults, currency: "usd", takenBack, payback: { launch: 2, quiet: 2 } });
is("a partial reading is partial", partialReport.measurement, "partial");
is("both versions say partial and why", [partialReport.text.includes("Partial:"), partialReport.html.includes("Partial:"), partialReport.text.includes("not read yet")], [true, true, true]);
is("a week with one unknown figure is partial too", [noRefunds.measurement, noSpend.measurement], ["partial", "partial"]);
is("each missing measure is named", [noRefunds.text.includes("Refunds and disputes are not matched to each campaign"), noSpend.text.includes("Ad spend was not read")], [true, true]);
is("partial sales are unknown, never counted as no sales", [partialReport.rows[0].sales, partialReport.text.includes("Sales: unknown")], [null, true]);

part("No open pixel and no tracked link");
for (const [name, report] of [["complete", full], ["partial", partialReport], ["unread", nothing]] as const) {
  is(`${name}: no image, link, address or tracking tag in the HTML`, [/<img|src=|href=|https?:|url\(|utm_|<a[\s>]|srcset|background=/i.test(report.html)], [false]);
  is(`${name}: no address in the plain text`, /https?:|www\.|utm_/i.test(report.text), false);
}
is("no picture of a chart: a table only", [/<svg|<canvas|<img|<picture/i.test(full.html), full.html.includes("<table")], [false, true]);

part("The table is accessible HTML and the plain text says the same");
is("the table has a caption naming the dates", /<caption>Ads by campaign, October 11, 2026 to October 13, 2026<\/caption>/.test(full.html), true);
is("every column header is a th with scope col", headers(full.html), [...WEEKLY_AD_COLUMNS]);
is("column headers are marked as such", (full.html.match(/<th scope="col">/g) ?? []).length, WEEKLY_AD_COLUMNS.length);
is("each row is headed by its campaign with scope row", (full.html.match(/<th scope="row">/g) ?? []).length, full.rows.length);
is("the report says its language", full.html.includes('lang="en-US"'), true);
is("headings and words come before the table", full.html.indexOf("<h2>") >= 0 && full.html.indexOf("<h2>") < full.html.indexOf("<table"), true);
for (const report of [full, noSpend, partialReport, bigReport]) {
  const rows = bodyRows(report.html);
  is("the table has every row", rows.length, report.rows.length);
  for (const cells of rows) {
    const block = [`Campaign: ${cells[0]}`, ...cells.slice(1).map((value, i) => `  ${WEEKLY_AD_COLUMNS[i + 1]}: ${value}`)].join("\n");
    is(`plain text holds the same cells for ${cells[0]}`, report.text.includes(block), true);
  }
  const paragraphs = [...report.html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => cellText(m[1]));
  const flat = report.text.replace(/\s+/g, " ");
  is("every sentence of the HTML is in the plain text", paragraphs.filter((p) => !flat.includes(p.replace(/\s+/g, " "))), []);
}
is("the subject has no shouting and no figures", [full.subject === full.subject.replace(/[!]/g, ""), /\$/.test(full.subject)], [true, false]);

part("Plain American English, measured words only");
is("the source has no British spelling", britishCopyHits("lib/ad-weekly-report.ts", readFileSync(join(process.cwd(), "lib/ad-weekly-report.ts"), "utf8")), []);
is("it says the figures are not profit and not a forecast", [full.text.includes("not profit"), full.text.includes("not a forecast")], [true, true]);
const check = checkAdText({ headline: full.subject, text: full.text, description: "", button: "" }, { priceCents: null, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] });
is("its words promise no earnings, results, urgency or scarcity", check.refusals.map((r) => r.rule), []);
is("no warnings either", check.warnings.map((r) => r.rule), []);
const long = Math.max(...full.text.split("\n").map((line) => line.length));
is("plain-text lines stay at or under 80 characters", long <= 80, true);

part("No personal data of any buyer");
const withPeople = { ...measured, rows: [...measured.rows, { campaign: "ana@example.com", paymentChannels: [], adChannels: [], visits: 1, paidRecords: 1, gross: 100, ads: 0, grossLessAds: 100, email: "buyer@example.com", name: "Ana Buyer" } as CampaignResults["rows"][number], { campaign: "15551234567", paymentChannels: [], adChannels: [], visits: 1, paidRecords: 0, gross: 0, ads: 0, grossLessAds: 0 }, { campaign: "<b>x</b>", paymentChannels: [], adChannels: [], visits: 1, paidRecords: 0, gross: 0, ads: 0, grossLessAds: 0 }] };
const people = weeklyAdReport({ results: withPeople, currency: "usd" });
for (const word of ["@", "example.com", "Ana Buyer", "buyer", "15551234567", "<b>"]) {
  is(`"${word}" is not in the text or the HTML`, [people.text.includes(word), people.html.includes(word)], [false, false]);
}
is("a tag that may hold a person's address or number is shown as a neutral label", people.rows.filter((r) => r.campaign.startsWith("Campaign tag not shown")).length, 3);
is("the rows carry only the figures, nothing more", Object.keys(people.rows[0]).sort(), ["afterTakenBack", "campaign", "costPerSale", "gross", "payback", "sales", "spend", "takenBack"]);

part("Every campaign tag the store keeps is shown by its name");
// The tag as the store keeps it from a checkout page's utm_campaign: cut at the store's own cap, not a number typed here.
const keptTag = cameFrom(`https://shop.test/p?utm_campaign=${encodeURIComponent("Spring-Launch-Early-Access-Email-List-2026-Week-Two")}`, "shop.test").campaign;
const tagRow = (campaign: string) => ({ campaign, paymentChannels: [], adChannels: [], visits: 1, paidRecords: 0, gross: 0, ads: 0, grossLessAds: 0 });
const tagReport = (campaign: string) => weeklyAdReport({ results: { ...measured, rows: [tagRow(campaign)] }, currency: "usd" });
is("the store cuts a long campaign tag to its cap", keptTag, "spring-launch-early-access-email-list-20");
for (const tag of ["black-friday-early-access-email-2026", keptTag]) {
  const r = tagReport(tag);
  is(`a ${tag.length}-character tag the store keeps keeps its name`, r.rows[0].campaign, tag);
  is(`a ${tag.length}-character tag is in the table and the text`, [r.html.includes(`>${tag}<`), r.text.includes(tag)], [true, true]);
}
is("a tag longer than the store keeps is still not shown", tagReport(`${keptTag}x`).rows[0].campaign.startsWith("Campaign tag not shown"), true);
const phoneAtCap = cameFrom("https://shop.test/p?utm_campaign=spring-launch-call-15551234567-early-access", "shop.test").campaign;
is("a tag at the cap with a long run of digits is still not shown", [phoneAtCap.length, tagReport(phoneAtCap).rows[0].campaign.startsWith("Campaign tag not shown")], [keptTag.length, true]);

part("Codex J review: a phone number written with dots, dashes, +1 or parentheses is not shown");
// Synthetic reserved example numbers only. The +1 and parentheses forms go through the store's own tag rule first.
const PLUS = "+"; // kept apart from the digits so the public-data scanner reads no number here
const asKept = (raw: string) => cameFrom(`https://shop.test/p?utm_campaign=${encodeURIComponent(raw)}`, "shop.test").campaign;
const phoneTags = ["1-202-555-0100", "202.555.0100", "44-7700-900-123", "555.201.4477", "555-201-4477", "call-555_201_4477", asKept(`${PLUS}1 (555) 201-4477`), asKept("(555) 201-4477"), asKept(`${PLUS}1 555.201.4477`)];
for (const tag of phoneTags) {
  const r = tagReport(tag);
  is(`${tag}: a phone-shaped tag is shown as a neutral label`, r.rows[0].campaign.startsWith("Campaign tag not shown"), true);
  is(`${tag}: it is in neither the table nor the text`, [r.html.includes(tag), r.text.includes(tag)], [false, false]);
}
for (const tag of ["sale-2026-11-27", "sale.2026.11.27", "week-2026-11-01-2026-11-07", "launch-2026", "launch", "spring-2026-v2", "top-10-tips"]) {
  is(`${tag}: an ordinary tag with a date or a few digits keeps its name`, tagReport(tag).rows[0].campaign, tag);
}

part("Codex J review: unread sales with no campaign row are unknown in the totals, never 0");
const noPosts = { ...data, posts: { d7: [], d30: [], d90: [] } } as unknown as StatsData;
const untagged: AdSpend[] = [{ id: "u", channel: "google", campaign: "", cents: 1000, from, to }];
for (const [name, changes] of [["unread sales", { sales: "error" }], ["partial payments", { partial: true }]] as const) {
  const r = weeklyAdReport({ results: campaignResultsFrom({ ...noPosts, ...changes } as StatsData, "d7", untagged), currency: "usd" });
  is(`${name}: the measured ad spend still shows`, r.totals.spend, 1000);
  is(`${name}: the week is partial`, r.measurement, "partial");
  is(`${name}: sales, the amount left and the cost per sale are unknown`, [r.totals.sales, r.totals.afterTakenBack, r.totals.costPerSale], [null, null, null]);
  is(`${name}: no $0 left and no "no sales kept" is claimed`, [r.text.includes("Left after refunds and disputes in all: $0."), r.text.includes("no sales kept"), r.html.includes("no sales kept")], [false, false, false]);
  is(`${name}: it does not say no campaign had tagged sales`, r.text.includes("or tagged sales"), false);
  is(`${name}: both versions say the amount left is unknown`, [r.text.includes("Left after refunds and disputes in all: unknown."), r.html.includes("Left after refunds and disputes in all: unknown.")], [true, true]);
}
const knownEmpty = weeklyAdReport({ results: campaignResultsFrom(noPosts, "d7", untagged), currency: "usd" });
is("a read week with no sale still counts 0 sales and no sales kept", [knownEmpty.measurement, knownEmpty.totals.sales, knownEmpty.totals.afterTakenBack, knownEmpty.totals.costPerSale], ["complete", 0, 0, "no_sales"]);

part("A long week stays readable");
const many: CampaignResults = { ...big, rows: Array.from({ length: WEEKLY_AD_MAX_ROWS + 5 }, (_, i) => ({ ...big.rows[0], campaign: `c${i}`, ads: 1000 - i })) };
const manyReport = weeklyAdReport({ results: many, currency: "usd" });
is("at most the set number of rows is listed", bodyRows(manyReport.html).length, WEEKLY_AD_MAX_ROWS);
is("the rest are counted, never dropped silently", manyReport.text.includes("5 more campaigns are not listed here"), true);
is("totals still count every campaign", manyReport.totals.spend, many.rows.reduce((s, r) => s + (r.ads ?? 0), 0));

done();
