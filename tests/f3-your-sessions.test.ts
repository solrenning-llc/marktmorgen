/**
 * 34 [F3], unit 2: "Your sessions" in the buyer area (app/[handle]/orders/sessions/page.tsx,
 * lib/client-sessions.ts, components/client-sessions.tsx, lib/buyer-words/sessions.ts).
 *
 * Checked, with synthetic stores, links and bookings only:
 *   - the page opens with the buyer's own link exactly as the purchases page does (openOrders:
 *     ORDERS_OPEN_UNITS before anything is read), and reads the bookings through the opening's meter;
 *   - an expired link, a store with no room and a reading that failed or ran late are each said as
 *     such, never as an empty list (rule 24); a reply of the wrong shape is unreadable, not empty;
 *   - a client sees only their own bookings: another client's booking, a booking with no address and
 *     a booking read under two addresses never show, and no address (staff or client) is drawn;
 *   - sessions to come soonest first, past sessions newest first, each list capped, and what was left
 *     out or could not be read is said;
 *   - a note or task shows only under its own session, and only when lib/client-shared.ts lets it;
 *   - every word in the seven languages a store sells in, headings in order, a status region for
 *     what went wrong, and the page's landmark for the layout's skip link.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrdersBusy, OrdersMeter } from "@/lib/buyer-orders";
import type { PaidCall } from "@/lib/calls";
import { type ClientSessions, type SessionsReads, SESSIONS_PAST_MOST, SESSIONS_UPCOMING_MOST, clientSessions } from "@/lib/client-sessions";
import { ClientSessionsView } from "@/components/client-sessions";
import { SESSIONS_WORDS, sessionsWords } from "@/lib/buyer-words/sessions";
import { LANGUAGE_CODES } from "@/lib/store-language";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 9, 15, 0);
const HOUR = 3_600_000;
const ANA = "ana@example.com";
const BEN = "ben@example.com";
const TOKEN = "a".repeat(64);
const store = { handle: "bela", name: "Bela Studio", language: "en", currency: "usd", stripeAccountId: "acct_synthetic01", look: { theme: "light" } } as unknown as Store;

let n = 0;
const booking = (email: string | null, start: number, extra: Partial<PaidCall> = {}): PaidCall =>
  ({ session: `cs_test_synth${String(++n).padStart(8, "0")}`, start, end: start + HOUR, product: "p1", title: "Coaching call", email, name: null, buyerTz: "America/New_York", moves: 0, answers: [], amount: 9000, currency: "usd", hosts: [], claim: "", lead: "", pi: "", due: null, cancel: null, ...extra }) as PaidCall;

/** The reads as the page makes them, with what each answers set by the case. */
function reads(open: () => Promise<{ admitted: boolean; email: string | null }>, read: () => Promise<unknown>): SessionsReads & { asked: number } {
  const out = {
    asked: 0,
    open: async (s: Store) => ({ ...(await open()), meter: new OrdersMeter(s) }),
    read: async () => {
      out.asked += 1;
      return read();
    },
  };
  return out as SessionsReads & { asked: number };
}
const asAna = () => Promise.resolve({ admitted: true, email: ANA });
const state = (view: ClientSessions) => view.state;

async function main(): Promise<void> {
  part("The opening: the buyer's own link, said truly when it cannot be used");
  is("a link that is not one (or has expired) is said as expired, with nothing read", await (async () => {
    const r = reads(() => Promise.resolve({ admitted: true, email: null }), () => Promise.resolve({ paid: [], partial: false }));
    return [state(await clientSessions(store, TOKEN, r, NOW)), r.asked];
  })(), ["expired", 0]);
  is("a store with no room left for the opening is busy, with nothing read", await (async () => {
    const r = reads(() => Promise.resolve({ admitted: false, email: null }), () => Promise.resolve({ paid: [], partial: false }));
    return [state(await clientSessions(store, TOKEN, r, NOW)), r.asked];
  })(), ["busy", 0]);
  is("an opening that refuses as busy is busy", state(await clientSessions(store, TOKEN, reads(() => Promise.reject(new OrdersBusy()), () => Promise.resolve({ paid: [], partial: false })), NOW)), "busy");
  is("an opening that fails otherwise (an unknown reply) is unreadable, never empty", state(await clientSessions(store, TOKEN, reads(() => Promise.reject(new Error("unknown reply")), () => Promise.resolve({ paid: [], partial: false })), NOW)), "unreadable");
  is("a grant whose address cannot be read is unreadable, never empty", state(await clientSessions(store, TOKEN, reads(() => Promise.resolve({ admitted: true, email: "not an address" }), () => Promise.resolve({ paid: [], partial: false })), NOW)), "unreadable");

  part("The bookings' reading: unknown is never an empty list");
  is("a reading that fails is unreadable", state(await clientSessions(store, TOKEN, reads(asAna, () => Promise.reject(new Error("Stripe list unreadable"))), NOW)), "unreadable");
  is("a reading the meter refuses is busy", state(await clientSessions(store, TOKEN, reads(asAna, () => Promise.reject(new OrdersBusy())), NOW)), "busy");
  is("a reading past its time is unreadable", state(await clientSessions(store, TOKEN, { ...reads(asAna, () => new Promise(() => {})), ms: 5 }, NOW)), "unreadable");
  for (const [what, reply] of [
    ["no reply", null],
    ["a list that is not a list", { paid: "none", partial: false }],
    ["no word on whether it is whole", { paid: [] }],
    ["a word on it that is not a yes or no", { paid: [], partial: "no" }],
    ["a booking that cannot be read", { paid: [booking(ANA, NOW + HOUR), { session: 7 }], partial: false }],
  ] as const) {
    is(`${what}: unreadable`, state(await clientSessions(store, TOKEN, reads(asAna, () => Promise.resolve(reply)), NOW)), "unreadable");
  }
  is("a store with no Stripe account has no bookings: an empty list, confirmed, and nothing read", await (async () => {
    const r = reads(asAna, () => Promise.resolve({ paid: [booking(ANA, NOW + HOUR)], partial: false }));
    const view = await clientSessions({ ...store, stripeAccountId: null } as unknown as Store, TOKEN, r, NOW);
    return [view.state === "shown" ? [view.upcoming.length, view.past.length, view.partial] : view.state, r.asked];
  })(), [[0, 0, false], 0]);

  part("Only this client's own bookings");
  const mine = [booking(ANA, NOW + 48 * HOUR), booking(" Ana@Example.com ", NOW + 2 * HOUR, { buyerTz: "Europe/Lisbon" }), booking(ANA, NOW - 72 * HOUR), booking(ANA, NOW - 24 * HOUR)];
  const others = [booking(BEN, NOW + 3 * HOUR, { title: "Ben's private call" }), booking(null, NOW + 4 * HOUR, { title: "Nobody's call" })];
  const twice = booking(ANA, NOW + 5 * HOUR, { title: "Read under two addresses" });
  const view = await clientSessions(store, TOKEN, reads(asAna, () => Promise.resolve({ paid: [...others, ...mine, twice, { ...twice, email: BEN }], partial: false })), NOW);
  if (view.state !== "shown") throw new Error(`expected shown, got ${view.state}`);
  is("to come: soonest first, her own only", view.upcoming.map((c) => c.session), [mine[1].session, mine[0].session]);
  is("past: newest first", view.past.map((c) => c.session), [mine[3].session, mine[2].session]);
  is("each in the zone she booked in", view.upcoming.map((c) => c.tz), ["Europe/Lisbon", "America/New_York"]);
  is("nothing left out, nothing unread", [view.upcomingMore, view.pastMore, view.partial], [0, 0, false]);
  is("no notes or tasks: none carries a share mark yet", [view.notes, view.tasks], [[], []]);
  is("a zone that cannot be read is shown in UTC, never dropped", await (async () => {
    const odd = await clientSessions(store, TOKEN, reads(asAna, () => Promise.resolve({ paid: [booking(ANA, NOW + HOUR, { buyerTz: "Mars/Olympus" })], partial: false })), NOW);
    return odd.state === "shown" ? odd.upcoming.map((c) => c.tz) : odd.state;
  })(), ["UTC"]);
  is("a session that ended a moment ago is past; one still running is to come", await (async () => {
    const edge = await clientSessions(store, TOKEN, reads(asAna, () => Promise.resolve({ paid: [booking(ANA, NOW - HOUR), booking(ANA, NOW - HOUR + 1)], partial: false })), NOW);
    return edge.state === "shown" ? [edge.upcoming.length, edge.past.length] : edge.state;
  })(), [1, 1]);

  part("Capped lists, and what they leave out is said");
  const many = [...Array.from({ length: SESSIONS_PAST_MOST + 3 }, (_, i) => booking(ANA, NOW - (i + 2) * HOUR)), ...Array.from({ length: SESSIONS_UPCOMING_MOST + 2 }, (_, i) => booking(ANA, NOW + (i + 1) * HOUR))];
  const capped = await clientSessions(store, TOKEN, reads(asAna, () => Promise.resolve({ paid: many, partial: true })), NOW);
  is("at most the caps, the rest counted, and a reading that stopped early said", capped.state === "shown" ? [capped.upcoming.length, capped.upcomingMore, capped.past.length, capped.pastMore, capped.partial] : capped.state, [SESSIONS_UPCOMING_MOST, 2, SESSIONS_PAST_MOST, 3, true]);
  is("the past kept are the newest", capped.state === "shown" ? capped.past[0].start : 0, NOW - 2 * HOUR);

  part("The words, in every language a store sells in");
  const shape = (w: object) => Object.keys(w).sort().join(",");
  is("every language has every word", LANGUAGE_CODES.map((code) => [code, shape(SESSIONS_WORDS[code]) === shape(SESSIONS_WORDS.en)]), LANGUAGE_CODES.map((code) => [code, true]));
  is("an unknown language reads English", sessionsWords("xx").pageTitle, "Your sessions");
  is("no word is empty", LANGUAGE_CODES.flatMap((code) => {
    const w = SESSIONS_WORDS[code];
    const texts = [w.pageTitle, w.intro("Bela"), w.upcoming(2), w.past(2), w.length("EST", 60), w.untitled, w.addToCalendar, w.joinOnOrders, w.backToList, w.getNewLink, w.noneYet("Bela"), w.recentOnly, w.partial, w.more(3), w.notesTitle("Bela"), w.tasksTitle, w.taskDone, w.taskOpen, w.due("Nov 9"), ...Object.values(w.notices).flatMap((x) => [x.title, x.body])];
    return texts.filter((t) => typeof t !== "string" || !t.trim()).map(() => code);
  }), []);
  is("one and many are told apart in English", [sessionsWords("en").upcoming(1), sessionsWords("en").upcoming(2), sessionsWords("en").more(1)], ["Coming up: 1 session", "Coming up: 2 sessions", "1 more session is not shown."]);

  part("What is drawn");
  const draw = (v: ClientSessions, language = "en") => renderToStaticMarkup(createElement(ClientSessionsView, { view: v, store: { ...store, language } as Store, token: TOKEN }));
  const html = draw(view);
  is("no address at all: not the client's, not another client's, not a teammate's", /@/.test(html.replace(/\/@bela\//g, "")), false);
  is("nothing of another client's booking", [html.includes("Ben&#x27;s private call"), html.includes("Nobody&#x27;s call"), html.includes("Read under two addresses")], [false, false, false]);
  is("headings in order: a section per list, a heading per session", (html.match(/<h[1-6]/g) ?? []).join(" "), "<h2 <h3 <h3 <h2 <h3 <h3");
  is("each list is a list", (html.match(/<ul/g) ?? []).length, 2);
  is("a session to come offers its calendar file, named by the session it is for and, the same product booked twice, by its time", [(html.match(/aria-labelledby="up0a up0 up0w"/g) ?? []).length, html.includes('id="up0w"')], [1, true]);
  is("the times are in the client's own zone", html.includes("Lisbon") || /GMT|WET|WEST/.test(html), true);
  is("where to join stays on the purchases page, linked back with the same link", html.includes(`href="/@bela/orders?token=${TOKEN}"`), true);
  for (const s of ["expired", "busy", "unreadable"] as const) {
    const out = draw({ state: s });
    is(`${s}: said in a status region, never as no sessions`, [/role="status"/.test(out), out.includes(sessionsWords("en").noneYet("Bela Studio")), out.includes(sessionsWords("en").notices[s].title)], [true, false, true]);
  }
  is("an expired link sends the client to ask for a new one, without the old link", draw({ state: "expired" }).includes(`href="/@bela/orders"`) && !draw({ state: "expired" }).includes(TOKEN), true);
  const empty = draw({ state: "shown", upcoming: [], past: [], upcomingMore: 0, pastMore: 0, partial: false, notes: [], tasks: [] });
  is("no sessions: said once, as no sessions in recent months, with no empty lists", [empty.includes(sessionsWords("en").noneYet("Bela Studio")), /<ul/.test(empty), /role="status"/.test(empty)], [true, false, false]);
  is("a reading that stopped early is said beside the list", draw(capped).includes(sessionsWords("en").partial), true);
  is("what the caps left out is said", [draw(capped).includes(sessionsWords("en").more(2)), draw(capped).includes(sessionsWords("en").more(3))], [true, true]);

  part("Notes and tasks, only under their own session");
  const s1 = view.upcoming[0].session;
  const shared = draw({ ...view, notes: [{ id: "0000000a", session: s1, at: Math.floor(NOW / 1000), text: "Bring your draft." }], tasks: [{ id: "abcdefghij", session: s1, text: "Read chapter 2", due: "2026-11-12", done: false }, { id: "abcdefghik", session: "cs_test_notherssession", text: "Not hers", due: "", done: false }] });
  is("a shared note and task show under their session, with headings", [shared.includes("Bring your draft."), shared.includes("Read chapter 2"), shared.includes("Notes from Bela Studio"), shared.includes("Your tasks")], [true, true, true, true]);
  is("a task whose session is not on the page is never drawn", shared.includes("Not hers"), false);
  is("the session with them is a heading with its notes and tasks under it", (shared.match(/<h[1-6]/g) ?? []).join(" "), "<h2 <h3 <h4 <h4 <h3 <h2 <h3 <h3");
  is("a task says whether it is done in words, not by color", shared.includes(sessionsWords("en").taskOpen), true);

  part("In every language");
  for (const code of LANGUAGE_CODES) {
    const out = draw(view, code);
    const w = SESSIONS_WORDS[code];
    is(`${code}: its own words`, [out.includes(w.upcoming(2).replace(/'/g, "&#x27;")), out.includes(w.past(2).replace(/'/g, "&#x27;"))], [true, true]);
  }

  part("The page");
  const page = readFileSync("app/[handle]/orders/sessions/page.tsx", "utf8");
  is("bounded as the purchases page is", page.includes("export const maxDuration = 30"), true);
  is("reads through the one opening and its meter", page.includes("clientSessions(store, token)"), true);
  is("one h1, the page's title", (page.match(/<h1/g) ?? []).length, 1);
  is("its main landmark is where the layout's skip link goes", page.includes('<main id="content"'), true);
  is("in the store's language, and never indexed", [page.includes("lang={said.lang.locale}"), page.includes("robots: { index: false, follow: false }")], [true, true]);
  const lib = readFileSync("lib/client-sessions.ts", "utf8");
  is("the opening is the purchases page's own", lib.includes("openOrders(store, token)"), true);
  is("the bookings are read through its meter, their moves taken before", lib.includes("meter.takeFor(ORDERS_CALL_MOVES, () => paidCallsRead(store), (read) => ordersMovesCommands(read.paid.length))"), true);
  is("and inside its time", lib.includes("withinOpening("), true);

  done();
}

void main();
