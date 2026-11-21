/**
 * 567 [GD1] (f), unit 3, review of #3841:
 * - Codex H2 (MEDIUM): the new use of a buyer's data, a store's team reading the past refunds and disputes of the
 *   person of an inbox conversation, is told where buyers read what is done with their data: the privacy policy and
 *   the person-data list, with its purpose, its scope (this store only), what is read, where from and that nothing
 *   is kept; and what a partial read leaves out is said as not checked.
 * - Claude 1 (LOW): the answer says under which address it was read, so a reader never takes "0 checked" as clean.
 */
import { readFileSync } from "node:fs";
import { REFUND_HISTORY_SCREEN, historyFrom } from "@/lib/buyer-history";
import { PERSON_DATA } from "@/lib/person-data";
import { done, is, part } from "./check";

// Held until the studio's screen exists (Claude 7's MEDIUM 2 on #3841): the paragraph and the entry wait, word for word,
// in docs/held/inbox-refund-history.md, and are in the policy and the list exactly when the screen is shown.
const held = readFileSync("docs/held/inbox-refund-history.md", "utf8").replace(/\s+/g, " ").replace(/&apos;/g, "'");
const policy = readFileSync("app/privacy/page.tsx", "utf8");
const listed = (PERSON_DATA as readonly { file: string }[]).some((row) => row.file === "lib/buyer-history.ts");

part("In the policy and the list exactly when the screen is shown");
is("the policy's paragraph", policy.includes('id="inbox-refund-history"'), REFUND_HISTORY_SCREEN.shown);
is("the person-data entry", listed, REFUND_HISTORY_SCREEN.shown);

part("The privacy policy's paragraph tells buyers (held)");
const privacy = held;
const at = privacy.indexOf('id="inbox-refund-history"');
const said = at < 0 ? "" : privacy.slice(at, at + 2_000);
is("a paragraph of its own, linkable", at >= 0, true);
is("what is read: refunds in full or in part, and disputes", /refunded in full or in part/.test(said) && /dispute/.test(said), true);
is("where from: that store's own Stripe account", /that store's own Stripe account/.test(said), true);
is("its scope: checkouts in that store only, with the conversation's address", /in that store/.test(said) && /conversation's address/.test(said), true);
is("who sees it: that store's team only", /only to that store's team/.test(said), true);
is("nothing kept but the day's count of checks", /keep nothing but/.test(said), true);
is("what a partial read leaves out is said as not checked", /not checked/.test(said), true);

part("The person-data entry names it (held)");
is("an entry for lib/buyer-history.ts", held.includes('{ file: "lib/buyer-history.ts"'), true);
is("kept: none", held.includes('how: "none"'), true);

part("The answer says under which address it was read");
const read = historyFrom(new Set(["mara"]), [{ object: "list", data: [], has_more: false }], "Ana@Example.com");
is("known, under the address as asked, normalised", read.state === "known" ? (read as { under?: string }).under : null, "ana@example.com");

done();
