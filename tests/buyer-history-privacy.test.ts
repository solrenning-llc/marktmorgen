/**
 * 567 [GD1] (f), unit 3, review of #3841:
 * - Codex H2 (MEDIUM): the new use of a buyer's data, a store's team reading the past refunds and disputes of the
 *   person of an inbox conversation, is told where buyers read what is done with their data: the privacy policy and
 *   the person-data list, with its purpose, its scope (this store only), what is read, where from and that nothing
 *   is kept; and what a partial read leaves out is said as not checked.
 * - Claude 1 (LOW): the answer says under which address it was read, so a reader never takes "0 checked" as clean.
 */
import { readFileSync } from "node:fs";
import { historyFrom } from "@/lib/buyer-history";
import { PERSON_DATA } from "@/lib/person-data";
import { done, is, part } from "./check";

const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ").replace(/&apos;/g, "'");

part("The privacy policy tells buyers");
const at = privacy.indexOf('id="inbox-refund-history"');
const said = at < 0 ? "" : privacy.slice(at, at + 2_000);
is("a paragraph of its own, linkable", at >= 0, true);
is("what is read: refunds in full or in part, and disputes", /refunded in full or in part/.test(said) && /dispute/.test(said), true);
is("where from: that store's own Stripe account", /that store's own Stripe account/.test(said), true);
is("its scope: checkouts in that store only, with the conversation's address", /in that store/.test(said) && /conversation's address/.test(said), true);
is("who sees it: that store's team only", /only to that store's team/.test(said), true);
is("nothing kept but the day's count of checks", /keep nothing but/.test(said), true);
is("what a partial read leaves out is said as not checked", /not checked/.test(said), true);

part("The person-data list names it");
const entry = (PERSON_DATA as readonly { file: string; how: string; what: string }[]).find((row) => row.file === "lib/buyer-history.ts");
is("an entry for lib/buyer-history.ts", Boolean(entry), true);
is("kept: none", entry?.how, "none");

part("The answer says under which address it was read");
const read = historyFrom(new Set(["mara"]), [{ object: "list", data: [], has_more: false }], "Ana@Example.com");
is("known, under the address as asked, normalised", read.state === "known" ? (read as { under?: string }).under : null, "ana@example.com");

done();
