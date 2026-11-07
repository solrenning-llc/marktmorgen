/**
 * docs/meta-requirements.md (39 [G1]) keeps its own rule: where two official
 * pages disagree, both are given and the stricter one is the working
 * assumption, and a figure not read on its page stays unverified. Two places
 * broke it (Codex T's review of #2916, findings LOW1 and LOW2):
 * - the WhatsApp pricing paragraph stated the October 1, 2026 utility change
 *   as settled, without the official FAQ that does support the service part
 *   and without the official pricing page that still says service and
 *   utility replies are not charged;
 * - the "missing before any channel code" row named only 300 sends a second,
 *   though the overview's 100 is the stricter of the two unverified figures.
 * The study is a document only; these checks hold its wording, not Meta's.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const doc = readFileSync("docs/meta-requirements.md", "utf8");
const lines = doc.split("\n");
const section = (heading: string) => {
  const start = doc.indexOf(`\n## ${heading}`);
  const next = doc.indexOf("\n## ", start + 4);
  return start < 0 ? "" : doc.slice(start, next < 0 ? undefined : next);
};
const whatsapp = section("6. WhatsApp");
const pricing = whatsapp.split("\n").find((line) => line.startsWith("**Pricing (who pays).**")) ?? "";
const sourceRow = (id: string) => lines.find((line) => line.startsWith(`| ${id} |`)) ?? "";
const sendRow = lines.find((line) => line.startsWith("| Send API, text/link/reaction/sticker |")) ?? "";
const gapRow = lines.find((line) => line.startsWith("| 750/hour private replies")) ?? "";

part("The study's own rule is still there");
is("the stricter page is the working assumption when two disagree", doc.includes("both are given and the stricter one is the working assumption"), true);
is("the pricing paragraph and both table rows are found", [pricing !== "", sendRow !== "", gapRow !== ""], [true, true, true]);

part("WhatsApp pricing: the official sources disagree (LOW1)");
is("the official FAQ is a listed source", /whatsappbusiness\.com\/resources\/faq/.test(sourceRow("S29")), true);
is("the pricing paragraph cites the FAQ for the October 1, 2026 service change", pricing.includes("[S29]") && /October 1, 2026/.test(pricing), true);
is("the 1,000 service messages a month are cited to the FAQ", /1,000 service messages[^.]*\[S29\]/.test(pricing), true);
is("the conflict with the official pricing page (S19) is recorded", /\[S19\][^.]*not charged|not charged[^.]*\[S19\]/.test(pricing) && /conflict/i.test(pricing), true);
is("the utility change is no longer stated as settled", pricing.includes("**from October 1, 2026 utility replies and service messages inside the window are charged per message**"), false);
is("the utility-within-window rate clause is marked unverified", /utility[^.]*\bunverified\b|\bunverified\b[^.]*utility/i.test(pricing), true);
is("no cost is made free: the creator's and Marktmorgen's own cost stay not zero", [whatsapp.includes("Nothing here says the creator's cost is zero"), /own cost[^.]*not zero/.test(whatsapp), /creator[^.]{0,40}\bfree\b|\bfree\b[^.]{0,40}creator/i.test(pricing)], [true, true, false]);

part("Send rate: the stricter figure is the working assumption (LOW2)");
is("the rate table names 100 a second as the working assumption", /working assumption[^|]*100/i.test(sendRow), true);
is("the gap row does not name 300 a second alone", /and 300\/s send \|/.test(gapRow), false);
is("the gap row counts to 100 a second, pending a dated read on Meta's page", gapRow.includes("100/s") && /pending/i.test(gapRow), true);

done();
