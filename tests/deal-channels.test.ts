/**
 * 639 [GL7](9), unit 1: deals' value by the channel their person first came
 * from (lib/deal-channels.ts), joined from what the store already knows: a
 * deal's email and a buyer's first channel in the ledger. Nobody is given a
 * channel they do not have; every deal is counted somewhere.
 */
import { dealChannelName, dealTotals, dealsByChannel } from "@/lib/deal-channels";
import { DEFAULT_STAGES, type Deal } from "@/lib/crm-rules";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealChannelsTable, DealChannelsWaiting } from "@/components/deal-channels-table";
import { done, is, part } from "./check";

const deal = (id: string, email: string, stage: string, cents: number): Deal => ({ id, title: id, email, cents, stage, note: "", createdAt: 1, updatedAt: 1 });
const ledger = new Map<string, string>([["ana@example.com", "newsletter"], ["ben@example.com", "instagram"], ["cy@example.com", ""]]);
const channelOf = (email: string) => (ledger.has(email) ? ledger.get(email)! : null);

const deals = [
  deal("d1", "ana@example.com", "won000", 50_000),
  deal("d2", "Ana@Example.com ", "offr00", 20_000),
  deal("d3", "ben@example.com", "lost00", 9_000),
  deal("d4", "ben@example.com", "won000", 10_000),
  deal("d5", "dee@example.com", "talk00", 30_000),
  deal("d6", "", "lead00", 5_000),
  deal("d7", "cy@example.com", "won000", 1_000),
  deal("d8", "ana@example.com", "gone00", 99_000),
  deal("d9", "ana@example.com", "lead00", -5),
];

part("Each deal under its person's first channel");
const result = dealsByChannel(deals, DEFAULT_STAGES, channelOf);
const row = (channel: string) => result.rows.find((one) => (one.kind === "channel" ? one.channel === channel : one.kind === channel));
const NOT_A_BUYER = "not_a_buyer";
const NO_PERSON = "no_person";
is("a buyer's deals under where they first came from, whatever the address's case", [row("newsletter")?.won, row("newsletter")?.open], [{ deals: 1, cents: 50_000 }, { deals: 2, cents: 20_000 }]);
is("won and lost apart", [row("instagram")?.won, row("instagram")?.lost, row("instagram")?.open], [{ deals: 1, cents: 10_000 }, { deals: 1, cents: 9_000 }, { deals: 0, cents: 0 }]);
is("a buyer with no channel is direct", row("direct")?.won, { deals: 1, cents: 1_000 });
is("someone who has not bought is never given a channel", row(NOT_A_BUYER)?.open, { deals: 1, cents: 30_000 });
is("a deal with nobody named", row(NO_PERSON)?.open, { deals: 1, cents: 5_000 });
is("a value that is not one counts as nothing, the deal still counted", row("newsletter")?.open.deals, 2);
is("a deal on a stage that is gone is left out and counted", result.unplaced, 1);

part("In an order a creator can read");
is("the most won first", result.rows.map((one) => one.key), ["channel:newsletter", "channel:instagram", "channel:direct", NOT_A_BUYER, NO_PERSON]);
is("names in plain words", [row("instagram")?.name, row("direct")?.name, row(NOT_A_BUYER)?.name, row(NO_PERSON)?.name], ["Instagram", "Direct or unknown", "Has not bought yet", "Nobody named on the deal"]);
is("a tag with no name of its own is shown as it was written", [dealChannelName("channel", "podcast-ep12"), row("newsletter")?.name], ["podcast-ep12", "newsletter"]);

part("Codex J (#1952) 1: a campaign called like a row that is not a channel keeps its own row");
for (const odd of ["not-a-buyer", "no-person", "not_a_buyer", "no_person", "not_known"]) {
  const mixed = dealsByChannel([deal("e1", "fay@example.com", "won000", 10_000), deal("e2", "gus@example.com", "won000", 10_000)], DEFAULT_STAGES, (email) => (email === "fay@example.com" ? odd : null));
  is(`a buyer from "${odd}" and someone who has not bought: two rows, never one`, mixed.rows.map((one) => [one.kind, one.channel, one.won.deals]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [["channel", odd, 1], ["not_a_buyer", "", 1]]);
}

part("Codex J (#1952) 2: with a partial ledger, someone not found is not known, never \"has not bought\"");
const partialRead = dealsByChannel([deal("p1", "hal@example.com", "won000", 10_000)], DEFAULT_STAGES, () => null, true);
is("counted under Not known yet", partialRead.rows.map((one) => [one.kind, one.name, one.won.deals]), [["not_known", "Not known yet", 1]]);
const partialHtml = renderToStaticMarkup(createElement(DealChannelsTable, { result: partialRead, currency: "usd" }));
is("the table never says Has not bought yet then, and says why", [partialHtml.includes("Has not bought yet"), partialHtml.includes("Not known yet"), partialHtml.includes("not as not having bought")], [false, true, true]);
is("with every sale read, the same person has not bought", dealsByChannel([deal("p1", "hal@example.com", "won000", 10_000)], DEFAULT_STAGES, () => null).rows.map((one) => one.name), ["Has not bought yet"]);

part("Totals");
is("every placed deal, by kind", dealTotals(result), { open: { deals: 4, cents: 55_000 }, won: { deals: 3, cents: 61_000 }, lost: { deals: 1, cents: 9_000 } });
is("nothing at all", [dealsByChannel([], DEFAULT_STAGES, channelOf).rows, dealTotals(dealsByChannel([], DEFAULT_STAGES, channelOf)).won], [[], { deals: 0, cents: 0 }]);
is("a ledger that could not read every sale says so", dealsByChannel(deals, DEFAULT_STAGES, channelOf, true).partial, true);

part("On the deals page");
const html = renderToStaticMarkup(createElement(DealChannelsTable, { result: dealsByChannel(deals, DEFAULT_STAGES, channelOf, true), currency: "usd" }));
is("a named section with its heading", html.includes('aria-labelledby="deal-channels-title"') && html.includes('<h2 id="deal-channels-title"'), true);
is("a table with a caption, column and row headers", [html.includes("<caption"), (html.match(/scope="col"/g) ?? []).length, (html.match(/scope="row"/g) ?? []).length], [true, 4, 6]);
is("each figure as a count and a value", html.includes(">1 · $500<") && html.includes(">2 · $200<"), true);
is("the totals in the table's foot", html.includes("<tfoot>") && html.includes("All deals"), true);
is("a deal left out is said, and a partial reading too", html.includes("1 deal is on a stage that no longer exists") && html.includes("Some of your sales could not be read"), true);
is("what the numbers are not", html.includes("Nothing is weighted or forecast"), true);
const unread = renderToStaticMarkup(createElement(DealChannelsTable, { result: null, currency: "usd" }));
is("sales that cannot be read: a plain line, no table", [unread.includes("<table"), unread.includes('role="status"')], [false, true]);
is("no deals yet: says what it will show", renderToStaticMarkup(createElement(DealChannelsTable, { result: dealsByChannel([], DEFAULT_STAGES, channelOf), currency: "usd" })).includes("No deals yet"), true);
is("while the sales are read, a status line", renderToStaticMarkup(createElement(DealChannelsWaiting)).includes('role="status"'), true);
const page = readFileSync("app/studio/deals/page.tsx", "utf8");
is("streamed in after the board, never holding it", page.includes("<Suspense fallback={<DealChannelsWaiting />}>") && page.indexOf("<DealsBoard") < page.indexOf("<DealChannelsLoader"), true);

done();
