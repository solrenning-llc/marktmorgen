/**
 * The list's health as a table in the email studio (570 [DR1], unit 2;
 * components/list-health-table.tsx, lib/list-health-rules.ts; added 4
 * November 2026). Checked on the real component, rendered to markup:
 *
 *   - a caption, four column headers and two row headers, scoped;
 *   - each row's level said in words, from KB20's own healthLevels, never
 *     only by colour; the room from roomBeforePause; the shares from
 *     shareWords, rounded down as KB20 rounds them;
 *   - each row says the level that pauses, count and share both needed, so
 *     a high share beside a low level reads as it should;
 *   - at the level, both room cells say the next notice of either kind
 *     pauses (pauseIfOver runs after every one counted), and the distance
 *     sentence is not shown (KB20's advice already says so);
 *   - nothing sent: no table, one sentence;
 *   - no word that claims an outcome no sender can know, outside the one
 *     honest sentence that says so;
 *   - the words explained in place, and the markup bounded at any count;
 *   - the studio's email page shows it in the health section with the
 *     seven days it has already read: no new reading.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { healthLevels, shareWords, type HealthLevel } from "@/lib/mail-health-levels";
import { BOTH_NEEDED, SOFT_BOUNCE_NOTE, TERMS, healthRows, levelWords, roomBeforePause, roomLine, roomWords } from "@/lib/list-health-rules";
import { ListHealthTable } from "@/components/list-health-table";
import { overTheLine } from "@/lib/mail-health";
import { done, is, part } from "./check";

const h = (sent: number, bounced = 0, complained = 0) => ({ sent, bounced, complained });
const render = (health: ReturnType<typeof h>) => renderToStaticMarkup(createElement(ListHealthTable, { health }));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
/** The text of each cell of a row whose header is `label`, in order. */
function cells(html: string, label: string): string[] {
  const row = html.split("<tr").find((r) => r.includes(`>${label}</th>`));
  if (!row) return [];
  // The text between tags, joined (React escapes "<" in text, so no tag hides inside it); never a tag-stripping replace.
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].split(/<[^>]*>/).join(""));
}

const WORDS: Record<HealthLevel, string> = {
  fine: "Under half of the level that pauses",
  watch: "Half or more of the level that pauses",
  near: "Four fifths or more of the level that pauses",
  over: "At the level that pauses",
};

function main(): void {
  part("A table with its headers");
  const html = render(h(1000, 4, 1));
  is("caption: what is counted, as KB20's healthLine says it", /<caption[^>]*>Email to your list, and the one email to buyers you brought over, in the last 7 days \(counting starts again when a pause ends\): how far it is from a pause<\/caption>/.test(html), true);
  is("six column headers, scoped, the corner one named", count(html, /<th scope="col"/g), 6);
  is("the column headers, the share naming how many were sent", [...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ["Measure", "Count", "Share of the 1,000 sent", "Level", "Level that pauses it", "More that would pause it"]);
  is("no empty header cell", /<td><\/td>|<td\/>|<th[^>]*><\/th>/.test(html), false);
  is("two row headers, scoped", [...html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ["Bounced for good", "Reported as spam"]);
  is("scrolls by keyboard at 320 px and 400%: a named, focusable region", /<div[^>]*class="[^"]*overflow-x-auto[^"]*"[^>]*role="region"[^>]*aria-label="[^"]+"[^>]*tabindex="0"/.test(html) || /<div(?=[^>]*overflow-x-auto)(?=[^>]*role="region")(?=[^>]*aria-label="[^"]+")(?=[^>]*tabindex="0")/.test(html), true);
  is("numbers in tabular figures", count(html, /tabular-nums/g) >= 4, true);
  is("only text tokens calibrated for 7:1", [...html.matchAll(/\btext-(?!sm|xs|base|lg|left|right|center)([a-z-]+)/g)].every((m) => m[1] === "ink" || m[1] === "ink-soft"), true);

  part("Levels in words, from KB20's own levels");
  const cases: [string, ReturnType<typeof h>][] = [
    ["fine", h(1000, 4, 1)],
    ["watch", h(1000, 13, 0)],
    ["near", h(1000, 21, 0)],
    ["over", h(1000, 25, 0)],
    ["watch, reports", h(5000, 0, 3)],
    ["near, reports", h(5000, 0, 4)],
    ["over, reports", h(5000, 0, 5)],
  ];
  is("the four levels named in words", (["fine", "watch", "near", "over"] as HealthLevel[]).map(levelWords), Object.values(WORDS));
  let levelOk = true;
  let roomOk = true;
  let shareOk = true;
  let countOk = true;
  for (const [, health] of cases) {
    const html = render(health);
    const levels = healthLevels(health);
    const room = roomBeforePause(health);
    const b = cells(html, "Bounced for good");
    const c = cells(html, "Reported as spam");
    if (b[2] !== WORDS[levels.bounces] || c[2] !== WORDS[levels.complaints]) levelOk = false;
    if (b[4] !== roomWords(room.bounces ?? -1, room.atLevel) || c[4] !== roomWords(room.complaints ?? -1, room.atLevel)) roomOk = false;
    if (b[4] !== (room.atLevel ? "The next bounce or spam report from a new address, unless more email goes out first" : room.bounces?.toLocaleString("en-US"))) roomOk = false;
    if (room.atLevel !== (levels.worst === "over")) roomOk = false;
    if (b[3] !== "25 or more, and 2% or more of those sent" || c[3] !== "5 or more, and 0.08% or more of those sent") levelOk = false;
    if (b[1] !== shareWords(health.bounced, health.sent) || c[1] !== shareWords(health.complained, health.sent)) shareOk = false;
    if (b[0] !== health.bounced.toLocaleString("en-US") || c[0] !== health.complained.toLocaleString("en-US")) countOk = false;
  }
  is("each level cell says healthLevels' level in words", levelOk, true);
  is("each room cell is roomBeforePause", roomOk, true);
  is("each share is shareWords, rounded down", shareOk, true);
  is("each count as counted", countOk, true);
  is("the cases cover all four levels", [...new Set(cases.map(([, x]) => healthLevels(x).worst))].sort(), ["fine", "near", "over", "watch"]);
  is("a rate just under the line never reads as it: 196 of 10,000 is 1.9%", cells(render(h(10000, 196)), "Bounced for good")[1], "1.9%");
  is("thousands written as thousands", cells(render(h(100000, 1200)), "Bounced for good"), ["1,200", "1.2%", "Half or more of the level that pauses", "25 or more, and 2% or more of those sent", "800"]);
  is("at the level: the next of either kind, on both rows", healthRows(h(1000, 25, 4))?.map((r) => [r.level, r.room, r.atLevel]), [["over", 1, true], ["near", 1, true]]);
  const share = render(h(10, 10, 0));
  is("a high share beside a low level makes sense: the level that pauses is said, both needed", [cells(share, "Bounced for good"), share.includes(BOTH_NEEDED)], [["10", "100.0%", "Under half of the level that pauses", "25 or more, and 2% or more of those sent", "15"], true]);

  part("The distance sentence, only short of the level");
  is("short of it: roomLine under the table", render(h(1000, 4, 1)).includes(roomLine(roomBeforePause(h(1000, 4, 1)))), true);
  is("near: still said", render(h(1000, 21, 0)).includes("At this many emails, 4 more bounces or 5 more spam reports would pause it."), true);
  const over = render(h(1000, 30, 0));
  is("an address already counted is not counted again (heardFromSender), and more email sent first can bring the share under: hence 'new address' and 'unless'", [/redisPipeline\(\[\["SET", seenKey\(notice\.store, email\), "1", "NX", "EX", KEPT_SECONDS\]\]\);\s*if \(first === null\) return "ignored";/.test(readFileSync("lib/mail-health.ts", "utf8")), overTheLine(h(1000, 25)) !== null, overTheLine(h(1400, 26)) === null], [true, true, true]);
  is("at the level: both room cells say the next notice of either kind pauses", [cells(over, "Bounced for good")[4], cells(over, "Reported as spam")[4]], ["The next bounce or spam report from a new address, unless more email goes out first", "The next bounce or spam report from a new address, unless more email goes out first"]);
  const bounceLine = render(h(1000, 25, 1));
  is("at the bounce line with 1 spam report: the next spam report pauses too (overTheLine answers bounces)", [cells(bounceLine, "Bounced for good")[4], cells(bounceLine, "Reported as spam")[4]], ["The next bounce or spam report from a new address, unless more email goes out first", "The next bounce or spam report from a new address, unless more email goes out first"]);
  is("at the level: no distance sentence, nothing that contradicts KB20's advice", over.includes("At this many emails") || over.includes(roomLine(roomBeforePause(h(1000, 30, 0)))), false);
  is("at the level by spam reports alone, the same", [cells(render(h(5000, 0, 5)), "Bounced for good")[4], render(h(5000, 0, 5)).includes("At this many emails")], ["The next bounce or spam report from a new address, unless more email goes out first", false]);

  part("Nothing sent");
  const none = render(h(0));
  is("no table", none.includes("<table"), false);
  is("one sentence that nothing was sent", none, "<p class=\"mt-3 text-sm text-ink-soft\">Nothing was sent in these 7 days, so there is nothing yet to compare with the level that pauses email to your list.</p>");
  is("unreadable counts: nothing at all", render(h(10, Number.NaN)), "");

  part("Words");
  const all = [h(1000, 4, 1), h(1000, 30, 6), h(0), h(3, 0, 4)].map(render).join("");
  is("the honest sentence is there", html.includes(TERMS.spamUnknown), true);
  is("no healthy, inbox, went to spam, delivered or opened outside that one sentence", /healthy|inbox|went to spam|delivered|opened/i.test(all.split(TERMS.spamUnknown).join("")), false);
  is("the words explained in place, in a list of terms", html.includes("<dl") && html.includes("What these words mean") && [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]).join("|") === "Bounce|Spam complaint", true);
  is("bounce explained, and that only bounces for good are counted", html.includes(`${TERMS.bounce} ${SOFT_BOUNCE_NOTE}`), true);
  is("which is what heardFromSender does: a temporary bounce is ignored", /if \(notice\.kind === "bounced" && !notice\.permanent\) return "ignored";/.test(readFileSync("lib/mail-health.ts", "utf8")), true);
  is("spam complaint explained", html.includes(TERMS.spamComplaint), true);
  is("the honest sentence names this page's own signals, no clicks", /clicks/.test(TERMS.spamUnknown) || !/visits and sales/.test(TERMS.spamUnknown), false);

  part("Bounded markup");
  const extremes = [h(1), h(1, 0, 1), h(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), h(9_999_999, 9_999_999, 0), h(3, 999_999_999, 999_999_999)];
  const sizes = extremes.map((x) => Buffer.byteLength(render(x)));
  is("at most 4,096 bytes at any count: a constant cost to send", sizes.every((n) => n <= 4096), true);

  part("On the studio's email page");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  const start = page.indexOf('aria-labelledby="mail-health-title"');
  const section = start < 0 ? "" : page.slice(start, page.indexOf("</section>", start));
  is("shown in the health section, from the seven days already read", /<ListHealthTable health=\{health\} \/>/.test(section), true);
  is("imported from the component", page.includes('import { ListHealthTable } from "@/components/list-health-table";'), true);
  is("one reading of the seven days on the page", count(page, /listHealth\(/g), 1);
  is("no reading of its own: the page imports nothing from Redis", /@\/lib\/redis/.test(page), false);
  const component = readFileSync("components/list-health-table.tsx", "utf8");
  is("the component reads nothing and runs on the server", /@\/lib\/redis|@\/lib\/mail-health"|"use client"|await /.test(component), false);
}

main();
done();
