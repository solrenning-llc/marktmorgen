/**
 * 613 [WP12] unit 2: Reddit's conversions API as rules only
 * (lib/reddit-conversions.ts). The token is kept only sealed; events from the
 * website only, at most seven days old, once per name and conversion id, in
 * batches of at most 1,000. Nothing is sent: the module has no request.
 */
import { readFileSync } from "node:fs";
import { REDDIT_MAX_BATCH, type RedditConversion, openRedditToken, readRedditToken, redditBatches, sealRedditToken } from "@/lib/reddit-conversions";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const event = (n: number, extra: Partial<RedditConversion> = {}): RedditConversion => ({ event: "Purchase", at: NOW - 60, conversionId: `cs_test_${n}`, actionSource: "WEBSITE", value: 10, currency: "USD", ...extra });

part("The token");
const token = "rdt_" + "x".repeat(40);
is("one line of visible characters", readRedditToken(`  ${token}\n`), token);
is("not one: refused", [readRedditToken("short"), readRedditToken("has space inside it ok"), readRedditToken(42)], [null, null, null]);
const sealed = sealRedditToken(token);
is("kept sealed, never as typed", typeof sealed === "string" && !sealed.includes(token), true);
is("opened back", sealed ? openRedditToken(sealed) : null, token);
is("a token sealed for something else does not open", sealed ? openRedditToken(sealed.slice(0, -4) + "AAAA") : "x", null);

part("What would go out");
is("the website only", redditBatches([event(1), event(2, { actionSource: "OTHER" as "WEBSITE" })], NOW).flat().length, 1);
is("nothing older than seven days", redditBatches([event(1, { at: NOW - 7 * 86_400 - 1 }), event(2, { at: NOW - 7 * 86_400 })], NOW).flat().map((e) => e.conversionId), ["cs_test_2"]);
is("nothing from the future", redditBatches([event(1, { at: NOW + 3600 })], NOW).length, 0);
is("once per event name and conversion id", redditBatches([event(1), event(1, { value: 99 }), event(1, { event: "Lead" })], NOW).flat().map((e) => `${e.event}:${e.value}`), ["Purchase:10", "Lead:10"]);
const many = redditBatches(Array.from({ length: 2_500 }, (_, i) => event(i)), NOW);
is("batches of at most 1,000", many.map((b) => b.length), [REDDIT_MAX_BATCH, REDDIT_MAX_BATCH, 500]);

part("Nothing sent");
const source = readFileSync("lib/reddit-conversions.ts", "utf8");
is("no request in the module", ["fetch(", "safeFetch", "https://ads-api"].some((word) => source.includes(word)), false);
done();
