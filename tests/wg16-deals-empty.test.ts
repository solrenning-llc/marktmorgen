/**
 * 656 [WG16], unit 5: the studio's deals board and its channels table use the
 * one empty-state pattern (components/empty-state.tsx): a heading and one
 * sentence. The board's "New deal" button is right above it, so no second
 * action is drawn; someone who may not change deals is told so in the sentence.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealChannelsTable } from "@/components/deal-channels-table";
import { done, is, part } from "./check";

part("The deals board");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("drawn by the pattern, its sentence for who can and cannot add deals", board.includes('<StudioEmptyState title={canChange ? "No deals yet" : "No deals in this pipeline yet"} body={canChange ? "When someone asks about something you sell outside a checkout, press \\u201cNew deal\\u201d and move it across the stages as the talk goes on." : "Deals show here once someone who can change them adds one."} className="mt-6 rounded-[var(--r-md)] bg-sand p-4" />'), true);
is("no bare paragraph left", board.includes("No deals yet. When someone asks about something"), false);

part("The channels table");
const channels = readFileSync("components/deal-channels-table.tsx", "utf8");
is("drawn by the pattern", channels.includes('<StudioEmptyState title="No deals yet" body="Once you add some, this shows which channels bring the people your deals are with." className="mt-4" />'), true);
is("no bare paragraph left", channels.includes(">No deals yet. Once you add some, this shows which channels"), false);
// Rendered, not read from the source (board #5285, row #2270): unread, and refused because studio requests ran short.
const unread = renderToStaticMarkup(createElement(DealChannelsTable, { result: null, currency: "usd" }));
is("an unread table still says so, in a status region, not as empty", /role="status">\s*Your sales could not be read just now/.test(unread) && !unread.includes("No deals yet"), true);
const short = renderToStaticMarkup(createElement(DealChannelsTable, { result: null, currency: "usd", note: "This needs 8 of your studio requests, and only 3 are left." }));
is("one refused for studio requests says that, in a status region, not as empty", /role="status">\s*This needs 8 of your studio requests/.test(short) && !short.includes("No deals yet"), true);

done();
