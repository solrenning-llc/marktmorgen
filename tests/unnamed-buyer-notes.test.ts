/**
 * A store kept from before lists, whose list could not be made yet, names
 * nobody in what it keeps (lib/store-readings.ts, listForNaming; review of
 * 2c1af02e0): its calendar file shows each booker as "A buyer", and its
 * studio keeps its sales without the biggest buyers. Nothing may promise what
 * is not shown (owner's rule VR): the calendar card says so instead of "with
 * who booked it" alone, the buyers' block says why the table is not there,
 * and the file itself says the names come back. A store that simply has no
 * buyers is told nothing of the kind, and a deleted person's booking keeps
 * its own wording.
 *
 * What fails here: the promise shown alone while names are not, the table
 * gone without a word, or the note shown where it is not true.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarEditor } from "@/components/calendar-editor";
import { BuyerNumbers } from "@/components/buyer-numbers";
import { bookedCalendar } from "@/lib/calendar-sync";
import { closingOf } from "@/lib/data-families";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const flat = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;|&ldquo;|&rdquo;|“|”/g, '"').replace(/\s+/g, " ");
const view = { feeds: [], subscribeUrl: "https://marktmorgen.com/api/store/calendar/abc.ics", stoppedAt: null };

part("The calendar card: the promise only where it is kept");
const named = flat(renderToStaticMarkup(createElement(CalendarEditor, { view, weekly: false })));
is("a store with a list: who booked each, as before, and no note", [named.includes("shows up with who booked it"), named.includes('shows as "A buyer"')], [true, false]);
const later = flat(renderToStaticMarkup(createElement(CalendarEditor, { view, weekly: false, namesLater: "on-their-own" } as never)));
is("a store with no list yet: each booking shown as \"A buyer\", said plainly, and the names coming back on their own", [later.includes('For now, each booking shows as "A buyer", without the buyer\'s name.'), later.includes("Names come back on their own, usually within a day, when this file is next updated.")], [true, true]);
is("and not the promise of who booked it", later.includes("shows up with who booked it"), false);
const afterChange = flat(renderToStaticMarkup(createElement(CalendarEditor, { view, weekly: false, namesLater: "after-change" } as never)));
is("a store not yet moved to product records: the names come back after its next saved change", afterChange.includes("Names come back after your next saved change to your store, usually within a day of it, when this file is next updated."), true);

part("The buyers' block: why the table is not there, only when it was left out for that");
const windows = { d7: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 }, d30: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 }, d90: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 } };
const base = { windows, range: "d90" as const, span: "90 days", currency: "usd", top: [] };
const plain = flat(renderToStaticMarkup(createElement(BuyerNumbers, base)));
is("a store whose reading names its buyers, or has none: nothing said", plain.includes("biggest buyers"), false);
const left = flat(renderToStaticMarkup(createElement(BuyerNumbers, { ...base, buyersLater: "on-their-own" } as never)));
is("left out for lack of a list: said, and when they come back", left.includes("Your biggest buyers show here again on their own, usually within a day, when these numbers are next updated."), true);
const leftChange = flat(renderToStaticMarkup(createElement(BuyerNumbers, { ...base, buyersLater: "after-change" } as never)));
is("a store not yet moved: after its next saved change", leftChange.includes("Your biggest buyers show here again after your next saved change to your store, when these numbers are next updated."), true);
const noRole = flat(renderToStaticMarkup(createElement(BuyerNumbers, { ...base, top: undefined, buyersLater: "on-their-own" } as never)));
is("a role that may not see buyers is told nothing about them", noRole.includes("biggest buyers"), false);

part("The file itself: one neutral line where a booker is unnamed for lack of a list, never for a deleted person");
const store = { name: "Shop", handle: "shop", catalog: { items: [], head: [], inline: [] } } as unknown as Store;
const at = Date.now() + 86_400_000;
const call = { session: "cs_1", start: at, end: at + 1_800_000, product: "p1", moves: 0 };
const unnamedFile = bookedCalendar(store, [{ ...call, email: null, name: null, unnamed: true } as never], Date.now(), []);
const erasedFile = bookedCalendar(store, [{ ...call, email: null, name: null, erased: true }], Date.now(), []);
const line = "Names show here once your store's details are up to date.";
is("unnamed for lack of a list: the line", unnamedFile.replace(/\r\n /g, "").replace(/\\,/g, ",").includes(line), true);
is("a deleted person's booking: its own wording, not the line", [erasedFile.replace(/\r\n /g, "").replace(/\\,/g, ",").includes(line), erasedFile.includes("A buyer whose details were deleted")], [false, true]);

part("The day's try mark goes with the store, as its readings' counts do");
is("nl:list:try: erased with the store, like nl:reading:day:", [closingOf("nl:list:try:x:2026-11-05")?.how, closingOf("nl:reading:day:x:2026-11-05")?.how], ["erase", "erase"]);
done();
