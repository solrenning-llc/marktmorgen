/**
 * Ad spend the studio could not read is not "no ad spend" (Claude 5, focal
 * review of #2924, comment 6731693728, MEDIUM A). app/studio/page.tsx read the
 * spend lines with `.catch(() => [])`: a typed line unreadable turned every
 * line into nothing, Meta's lines included, and Meta's lines unreadable left
 * the typed ones as all of it. Either way the panel showed "Ad spend recorded
 * $0.00" and a result after ads with the unread spend left out, so the
 * figure the creator reads as what remains was inflated.
 *
 * The contract held here:
 *  - The studio never turns a spend read it could not make into an empty
 *    list, and never reads through readSpends, which hands back the typed
 *    lines alone when Meta's cannot be read (lib/ad-spend.ts).
 *  - The numbers panel, given spend that could not be read (`spends: null`),
 *    says so in a status message in plain words, shows no figure computed
 *    as if the unread spend were $0 (no "Ad spend recorded" amount, no
 *    result after refunds and ads), and keeps the rest of the panel.
 *  - Given spend that was read, the same figures are shown (control).
 *
 * `spends: null` is the shape chosen for "could not be read" (null for an
 * unknown reading, as the other studio readers do); a fix that picks another
 * shape changes the two renders below and says so (rule 23).
 *
 * Synthetic only: the Redis stand-in and a store made here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsPanel } from "@/components/stats-panel";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { readStats, studioStats, type StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const OWNER = "studio-spends-unread@example.com";

type Props = Parameters<typeof StatsPanel>[0];
const render = (data: StatsData, spends: AdSpend[] | null): { html: string; error: string } => {
  try {
    return { html: renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends } as unknown as Props)), error: "" };
  } catch (error) {
    return { html: "", error: error instanceof Error ? error.message : String(error) };
  }
};

/** The value under a tile's label, or null when the tile is not there. */
function tile(html: string, label: string): string | null {
  const at = html.indexOf(">" + label + "</dt>");
  if (at < 0) return null;
  const value = /<dd[^>]*>([^<]*)<\/dd>/.exec(html.slice(at));
  return value ? value[1] : null;
}

/** The daily panel's sentence "The recorded result for these days is X," or null when the panel is not there. */
function dailyResult(html: string): string | null {
  const match = /The recorded result for these days is ([^,]*),/.exec(html);
  return match ? match[1] : null;
}

/** The text of every element with role="status". */
function statuses(html: string): string[] {
  const out: string[] = [];
  const re = /role="status"[^>]*>([\s\S]*?)<\/(?:p|div|section|span)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return out;
}

const unknownOrAbsent = (value: string | null) => value === null || value === "—";

async function main(): Promise<void> {
  console.error = () => {};
  await claimHandle(OWNER, "studio-spends-unread", "Spend Unread Store", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const stats = await readStats(store, Date.UTC(2026, 9, 14));
  if (!stats) throw new Error("Missing test stats");
  const base = studioStats(store, stats, null, "none", []);
  const last = base.days.slice(-3).map((d) => d.date);
  if (last.length < 3) throw new Error("Missing test days");
  const totals = { visitors: 50, views: 100, checkouts: 10, sales: 2, cents: 4000 };
  // Two $20 payments from Instagram and one $5 refund in the 7 days shown; the ad line below is $10 over the same days.
  const data = {
    ...base,
    sales: "ok",
    currency: "usd",
    cashflowComplete: true,
    totals: { ...base.totals, d7: totals, all: totals },
    channelDays: { instagram: { [last[0]]: 2000, [last[1]]: 2000 } },
    refundDays: { [last[2]]: 500 },
    refunds: { d7: [{ source: "instagram", refunds: 1, cents: 500 }], d30: [], d90: [] },
  } as unknown as StatsData;
  const line: AdSpend = { id: "a1b2c3d4", channel: "instagram", campaign: "", cents: 1000, from: last[0], to: last[2] };

  part("Control: spend that was read is used");
  const known = render(data, [line]);
  is("renders", known.error, "");
  is("Ad spend recorded shows the line", tile(known.html, "Ad spend recorded"), "$10");
  is("the result after refunds and ads takes it off", tile(known.html, "After refunds and ads"), "$25");
  is("the daily result takes it off", dailyResult(known.html), "$25");
  is("no unread-spend notice", statuses(known.html).some((s) => /ad spend/i.test(s) && /could not be read|couldn't be read|could not read/i.test(s)), false);

  part("Spend that could not be read is said, never shown as $0");
  const unread = render(data, null);
  is("the panel still renders", unread.error, "");
  is(
    "a status message says the ad spend could not be read",
    statuses(unread.html).some((s) => /ad spend/i.test(s) && /could not be read|couldn't be read|could not read/i.test(s)),
    true,
  );
  is("no Ad spend recorded amount", unknownOrAbsent(tile(unread.html, "Ad spend recorded")), true);
  is("no result after refunds and ads computed without the spend", unknownOrAbsent(tile(unread.html, "After refunds and ads")), true);
  is("no daily result computed without the spend", unknownOrAbsent(dailyResult(unread.html)), true);
  is("the rest of the panel stays: visitors", (tile(unread.html, "Visitors") ?? "").includes("50"), true);
  is("the rest of the panel stays: payments received", tile(unread.html, "Payments received"), "$40");

  part("The studio page never reads unread spend as none");
  const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");
  is("no spend read whose failure becomes an empty list", /readSpend\w*\([^()]*\)\s*\.catch\(\s*\(\)\s*=>\s*\[\s*\]\s*\)/.test(page), false);
  is("no readSpends, which hands back the typed lines alone when Meta's cannot be read", /\breadSpends\s*\(/.test(page), false);

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
