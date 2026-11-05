/**
 * The public webhooks page names exactly the events the code sends (Claude 1's
 * inbox message C2-18, after 630 [HN6](18) added membership.changed and
 * dispute.opened). Checked: the count in the block's title is the number of
 * events in WEBHOOK_EVENTS, written as a word; every event is named in a title
 * of that block, and no title names an event the code does not send; the two
 * new events say what they carry, read from the payloads in lib/webhooks.ts.
 */
import { readFileSync } from "node:fs";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { done, is, part } from "./check";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
const page = FEATURE_PAGES.find((p) => p.slug === "webhooks");
const block = page?.blocks.find((b) => b.kind === "features" && / events, and how they arrive$/.test(b.title ?? "")) as { title: string; items: { title: string; body: string }[] } | undefined;
const titles = (block?.items ?? []).map((i) => i.title);
const named = titles.flatMap((t) => t.match(/\b[a-z]+\.[a-z]+\b/g) ?? []);

part("The count in the title");
is("as many events as the code sends, in words", block?.title, `${WORDS[WEBHOOK_EVENTS.length][0].toUpperCase()}${WORDS[WEBHOOK_EVENTS.length].slice(1)} events, and how they arrive`);

part("Every event, and only those");
is("each event the code sends is named", WEBHOOK_EVENTS.filter((e) => !named.includes(e)), []);
is("no event the code does not send", named.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e)), []);
is("each named once", named.length, new Set(named).size);

part("The two newest say what they carry");
const code = readFileSync("lib/webhooks.ts", "utf8");
const body = (e: string) => block?.items.find((i) => i.title === e)?.body ?? "";
const payload = (e: string) => {
  const at = code.indexOf(`emitEvent(store, "${e}"`);
  return at < 0 ? "" : code.slice(at, code.indexOf("}, created)", at));
};
is("membership.changed: what it was and what it is now", [body("membership.changed").includes("what it was and what it is now"), /\bfrom,\s*\n\s*to,/.test(payload("membership.changed"))], [true, true]);
is("dispute.opened: amount, reason and the date the answer is due", [["the amount", "the reason Stripe reports", "when Stripe gives one, the date your answer is due"].every((w) => body("dispute.opened").includes(w)), ["amount_cents", "reason", "evidence_due_by"].every((k) => payload("dispute.opened").includes(k))], [true, true]);
is("the introduction says disputes too", page?.intro.includes("refunds and disputes"), true);

done();
