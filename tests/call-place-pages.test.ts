/**
 * Where an in-person booking happens, on the pages (520 [LB1], unit 3;
 * added 2 November 2026). Checked:
 *
 *   - the store's card says "in person", never "online" nor "call", for one
 *     person, a group and dated sessions, with and without dates to come, in
 *     every language a store sells in;
 *   - the booking page's line under the title gives the address, and no
 *     link; the thanks page and the buyer's list of purchases say where as
 *     text and offer no link to join, nor say one will come; the buyer's list
 *     never uses a room kept from when it was online (read in their source);
 *   - the studio's editor offers "In person, at your address" with a labeled
 *     address field, turns every link off when it is chosen and in person
 *     off when another is, sends the address only then, and shows it in the
 *     saved summary (read in its source);
 *   - the studio's save no longer refuses a place.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProductFacts } from "@/components/store-product";
import { bookingWords } from "@/lib/buyer-words/booking";
import { speechFor } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import type { Listing, Store } from "@/lib/store";
import { done, is, part } from "./check";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const ADDRESS = ["Bela Studio", "12 Harbor Street"];

async function main(): Promise<void> {
  part("The store's card");
  const store = { handle: "bela", name: "Bela", language: "en", currency: "usd" } as unknown as Store;
  const card = (call: CallSetup) =>
    renderToStaticMarkup(createElement(ProductFacts, { store, product: { id: "p1", title: "Haircut", priceCents: 4500, call, course: null, recurring: null, options: [], pwyw: null, plan: null, trial: null, bundle: null } as unknown as Listing }));
  const one = readSetup({ kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, place: ADDRESS }) as CallSetup;
  const group = { ...one, seats: 4 };
  const start = Math.floor((Date.now() + 9 * 86_400_000) / 60_000) * 60_000;
  const live = readSetup({ kind: "live", tz: NY, noticeHours: 1, place: ADDRESS, sessions: [{ id: "s1", start, minutes: 60, seats: 6 }] }) as CallSetup;
  const past = { ...live, sessions: live.sessions.map((s) => ({ ...s, start: start - 30 * 86_400_000 })) };
  const lines = [card(one), card(group), card(live), card(past)];
  is("one person, a group, dated sessions and none to come: in person, never online or a call", lines.map((html) => [/in person/.test(html), /online|call/i.test(html)]), Array(4).fill([true, false]));
  is("in every language", LANGUAGE_CODES.map((code) => { const { w } = speechFor(code, "usd"); return [code, /online|en línea|en ligne/i.test(`${w.inPersonOne(60)} ${w.inPersonGroup(60, 4)} ${w.inPersonLive(2)} ${w.inPersonLiveNone}`)]; }), LANGUAGE_CODES.map((code) => [code, false]));

  part("The booking page");
  const b = bookingWords("en");
  is("the line under the title gives the address", [b.inPersonLine(60, "Bela Studio, 12 Harbor Street"), b.inPersonGroupLine(4, 60, "Bela Studio"), b.inPersonLiveLine("Bela Studio")], ["60 minutes · in person, at Bela Studio, 12 Harbor Street", "Up to 4 people · 60 minutes · in person, at Bela Studio", "Live session · in person, at Bela Studio"]);
  const book = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("the page to move a booking says where too", book.includes("{setup.place ? <p className=\"mt-1 text-sm\" data-call-place=\"\">{b.whereAt(placeLine(setup.place))}</p> : null}"), true);
  is("and is used before any link is looked at", book.indexOf("if (setup.place)") > 0 && book.indexOf("if (setup.place)") < book.indexOf("const where = setup.meet"), true);

  part("After paying, and the buyer's list");
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("the thanks page says where, uses no kept room, and says no link will come", [thanks.includes("whereAt(placeLine(booked.setup.place))"), thanks.includes("sessionId && !order.product.call.place"), /booked\.setup\.place\s*\?\s*""\s*:\s*booked\.room/.test(thanks)], [true, true, true]);
  const orders = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  is("the buyer's list says where before any link", orders.indexOf("call.setup.place ? (") > 0 && orders.indexOf("call.setup.place ? (") < orders.indexOf("call.room ? ("), true);
  is("and never uses a room kept from when it was online", readFileSync("lib/buyer-orders.ts", "utf8").includes("if (setup.place) rooms[i] = null;"), true);

  part("The studio's editor");
  const editor = readFileSync("components/call-editor.tsx", "utf8");
  is("offers in person, with a labeled address field and its help", [editor.includes("In person, at your address"), editor.includes('<label htmlFor={placeId} className="field-label">Your address</label>'), editor.includes('aria-describedby={`${placeId}-help`}')], [true, true, true]);
  is("choosing it turns every link off, and choosing another turns it off", editor.includes('return { ...draft, inPerson: where === "place", video: where === "video", meet: where === "google" || where === "zoom" ? where : null };'), true);
  is("sends the address only then, for weekly hours and sessions", (editor.match(/\.\.\.\(draft\.inPerson \? \{ place: draft\.place \} : \{\}\)/g) ?? []).length, 2);
  is("hides each session's meeting link field then", editor.includes("{draft.video || draft.inPerson ? null : ("), true);
  is("and its saved summary says where", (editor.match(/In person, at: \$\{placeLine\(setup\.place\)\}/g) ?? []).length, 2);


  part("Behavior");
  const { choose } = await import("@/components/call-editor");
  const draft = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/r", video: true, meet: "zoom", inPerson: false, place: "Bela Studio", seats: "1", sessions: [] } as never;
  const inPerson = choose(draft, "place");
  const back = choose(inPerson, "own");
  is("choosing in person turns every link off and keeps what was typed; choosing a link turns it off again", [[inPerson.inPerson, inPerson.video, inPerson.meet, inPerson.room, inPerson.place], [back.inPerson, back.video, back.meet, back.place]], [[true, false, null, "https://example.com/r", "Bela Studio"], [false, false, null, "Bela Studio"]]);
  const { roomsFor } = await import("@/lib/call-rooms");
  const placed = { ...one, room: "https://example.com/kept", video: false } as CallSetup;
  const online = { ...one, place: undefined, room: "https://example.com/online", video: false } as unknown as CallSetup;
  is("no room for an in-person booking, even one kept in its setup; the others as before", await roomsFor(null, [{ product: "p1", setup: placed, session: "cs_test_a", start, end: start + 3_600_000 }, { product: "p2", setup: online, session: "cs_test_b", start, end: start + 3_600_000 }]), [null, "https://example.com/online"]);
  const { deliveryWords } = await import("@/lib/answers");
  is("the store's assistant says it is in person, at the address", deliveryWords({ id: "p1", title: "Haircut", priceCents: 4500, call: one, recurring: null, course: null, bundle: null, pick: null, options: [], file: null, link: null } as unknown as Listing).startsWith("It is booked in person, at Bela Studio, 12 Harbor Street"), true);
  const route = readFileSync("app/api/store/call/route.ts", "utf8");
  is("in person chosen with no address is refused, never saved as a call", route.includes('if (asked !== undefined && asked !== null && !setup.place) return Response.json({ ok: false, error: "place" }, { status: 400 });'), true);
  is("and the editor says so before sending", (editor.match(/if \(draft\.inPerson && !draft\.place\.trim\(\)\) \{/g) ?? []).length, 2);
  is("switching between online and in person with bookings to come is refused, as switching kind is", readFileSync("lib/calls.ts", "utf8").includes("whereOf(before).kind !== whereOf(setup).kind"), true);
  is("a package of in-person sessions promises no meeting link", [readFileSync("lib/call-packages.ts", "utf8").includes("product.call?.place ? b.packageKeepPlace : b.packageKeep"), /link/i.test(bookingWords("en").packageKeepPlace.replace("that link is how you book", ""))], [true, false]);
  is("the studio's upcoming list says where", readFileSync("app/studio/page.tsx", "utf8").includes("`In person, at: ${placeLine(product.call.place)}`"), true);

  done();
}

void main();
