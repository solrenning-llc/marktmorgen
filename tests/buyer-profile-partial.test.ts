/**
 * A buyer's page in the studio says which of its parts could not be read
 * (rule 24, inventory item 8): purchases handed over without a Stripe payment
 * (imported, given, bought for others, paid with PayPal), the amount of a
 * PayPal sale, the calls coming up and the sequences they were started on.
 * Before, each of those reads ended in `.catch(() => [])`, so a failed read
 * looked exactly like "none", and the page looked complete.
 *
 * Checked: a healthy read names no part; a confirmed absence (nothing
 * imported, no sequences, no calls) names no part either; each failed read
 * names its own part and only it, and the rest of the page is still there;
 * the studio page shows the sentence that names them, as a status.
 *
 * The team's notes about the buyer too (Claude 2's report on #3159): a notes
 * reply that is not exactly a hash of notes as addPersonNote writes them was
 * read as "no notes", so the page said "No notes yet." about a buyer who has
 * some. Only the exact reply for a hash with nothing in it (an empty list) is
 * "no notes"; anything else names the notes as unread, and the page shows
 * that instead of the notes box.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as profiles from "@/lib/buyer-profile";
import { addPersonNote, buyerProfile, readPersonNotes, removePersonNote } from "@/lib/buyer-profile";
import { personKey } from "@/lib/person-key";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { importedKey } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.parse("2026-11-08T12:00:00Z") / 1000);
const STATS = "b".repeat(32);
const LIST = "list0002";
const IMPORT_JOB = "0123456789abcdef01234567";
const PAYPAL_ORDER = "PAYPAL0RDER0001";
const FLOW = "flow00000001";
const EMAIL = "buyer@example.com";
const addressHash = (email: string) => createHash("sha256").update(`nimbus-flow:${email}`).digest("hex").slice(0, 32);

let callsDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (url.pathname === "/v1/checkout/sessions") {
    // The calls' own reading of the store's checkouts (lib/calls.ts) asks by time; the buyer's payments by address.
    if (url.searchParams.has("created[gte]")) {
      if (callsDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
      return new Response(JSON.stringify({ data: [], has_more: false }));
    }
    return new Response(JSON.stringify({ data: [], has_more: false }));
  }
  if (url.pathname === "/v1/charges") return new Response(JSON.stringify({ data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const products = [
  { id: "course1", title: "Bread School", course: null, options: [] },
  { id: "kit1", title: "Starter Kit", course: null, options: [] },
  { id: "call1", title: "A call with Ada", course: null, options: [] },
];

function shop(): Store {
  return {
    sid: "sidbake00002",
    handle: "bakery",
    name: "Oven Notes",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    listId: LIST,
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_profile2",
    pastBuyers: true,
    catalog: {
      id: null,
      head: [],
      items: [
        { id: "course1", kind: 1, options: [] },
        { id: "kit1", kind: 1, options: [] },
        { id: "call1", kind: 1 | 4, options: [] },
      ],
      inline: products,
    },
  } as unknown as Store;
}

/** Makes every pipeline holding one of these commands on a key starting so fail, as a Redis that could not be reached. */
async function failing<T>(fails: [string, string][], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => fails.some(([cmd, prefix]) => c[0] === cmd && String(c[1]).startsWith(prefix)))) throw new Error("Redis could not be reached");
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const unreadOf = (profile: unknown) => (profile as { unread?: unknown }).unread;

async function seed(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    [
      "HSET",
      importedKey(STATS, EMAIL),
      "course1",
      JSON.stringify({ at: NOW - 100, job: IMPORT_JOB }),
      "kit1",
      JSON.stringify({ at: NOW - 50, job: `paypal:${PAYPAL_ORDER}` }),
    ],
    ["SET", `nl:ppsell:paid:${PAYPAL_ORDER}`, JSON.stringify({ store: STATS, order: PAYPAL_ORDER, capture: "CAP1", email: EMAIL, product: "kit1", cents: 1200, currency: "usd", at: NOW - 50, meta: {} })],
    ["SET", `nl:mail:flows:${LIST}`, JSON.stringify([{ id: FLOW, name: "Welcome", active: true, trigger: "joined", steps: [] }])],
    ["SET", `nl:mail:enr:${FLOW}:${addressHash(EMAIL)}`, "1"],
  ]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_profile_only_a_stand_in";
  const store = shop();

  await seed();

  part("Every part read");
  const whole = await buyerProfile(store, EMAIL);
  is("no part is named", unreadOf(whole), []);
  is(
    "the imported purchase and the PayPal sale are on it",
    whole.orders.map((o) => [o.kind, o.title, o.cents, o.note]),
    [
      ["sale", "Starter Kit", 1200, "paypal"],
      ["brought", "Bread School", 0, "imported"],
    ],
  );
  is("the PayPal sale is counted in what they paid", whole.paid, 1200);
  is("the sequence they were started on", whole.sequences, ["Welcome"]);
  is("no call coming up, read in full", whole.calls, []);

  part("Nothing there, confirmed");
  redis.clear();
  const empty = await buyerProfile(store, EMAIL);
  is("nothing imported, no sequences, no calls: no part is named", [unreadOf(empty), empty.orders.length, empty.sequences, empty.calls], [[], 0, [], []]);

  part("Purchases handed over could not be read");
  await seed();
  const noImports = await failing([["HGETALL", "nl:imp:buy:"]], () => buyerProfile(store, EMAIL));
  is("the imported part is named, and only it", unreadOf(noImports), ["imported"]);
  is("the rest is still there", noImports.sequences, ["Welcome"]);

  part("A PayPal sale's amount could not be read");
  const noPaypal = await failing([["GET", "nl:ppsell:paid:"]], () => buyerProfile(store, EMAIL));
  is("the PayPal part is named, and only it", unreadOf(noPaypal), ["paypal"]);
  is(
    "the purchase is still listed, without an amount it cannot stand behind",
    noPaypal.orders.map((o) => [o.kind, o.title, o.cents, o.note]),
    [
      ["brought", "Starter Kit", 0, "paypal"],
      ["brought", "Bread School", 0, "imported"],
    ],
  );

  part("The sequences could not be read");
  const noFlows = await failing([["GET", "nl:mail:flows:"]], () => buyerProfile(store, EMAIL));
  is("the sequences are named when the list of sequences fails", [unreadOf(noFlows), noFlows.sequences], [["sequences"], []]);
  const noStarts = await failing([["EXISTS", "nl:mail:enr:"]], () => buyerProfile(store, EMAIL));
  is("and when who was started on them fails", [unreadOf(noStarts), noStarts.sequences], [["sequences"], []]);
  is("the purchases are still there", noStarts.orders.length, 2);

  part("A PayPal record kept in another shape is not read as no record (Claude 6 on #3159)");
  const paypalRecord = { store: STATS, order: PAYPAL_ORDER, capture: "CAP1", email: EMAIL, product: "kit1", cents: 1200, currency: "usd", at: NOW - 50, meta: {} };
  for (const [label, raw] of [
    ["text that is not JSON", "not json {"],
    ["cents written as text", JSON.stringify({ ...paypalRecord, cents: "1200" })],
    ["a record of another order", JSON.stringify({ ...paypalRecord, order: "PAYPAL0RDER0009" })],
  ] as const) {
    await seed();
    await redis.pipeline([["SET", `nl:ppsell:paid:${PAYPAL_ORDER}`, raw]]);
    const odd = await buyerProfile(store, EMAIL);
    is(
      `${label}: the PayPal part is named, the sale listed without an amount, and nothing counted`,
      [unreadOf(odd), odd.orders.find((o) => o.title === "Starter Kit")?.cents, odd.paid, typeof odd.paid],
      [["paypal"], 0, 0, "number"],
    );
  }

  part("Who was started on a sequence, answered in another shape, is not \"started on none\"");
  for (const [label, reply] of [["no entry per sequence", []], ["a word", ["yes"]], ["a count of 2", [2]], ["a null", [null]]] as [string, unknown[]][]) {
    await seed();
    const original = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((c) => c[0] === "EXISTS" && String(c[1]).startsWith("nl:mail:enr:")) ? [...reply] : original.call(redis, commands)) as typeof redis.pipeline;
    const odd = await buyerProfile(store, EMAIL).finally(() => {
      redis.pipeline = original;
    });
    is(`${label}: the sequences are named, none shown`, [unreadOf(odd), odd.sequences], [["sequences"], []]);
  }
  await seed();
  await redis.pipeline([["DEL", `nl:mail:enr:${FLOW}:${addressHash(EMAIL)}`]]);
  const notStarted = await buyerProfile(store, EMAIL);
  is("control: a sequence they were not started on (EXISTS 0) is no sequence, read in full", [unreadOf(notStarted), notStarted.sequences], [[], []]);

  part("The calls could not be read");
  callsDown = true;
  const noCalls = await buyerProfile(store, EMAIL);
  callsDown = false;
  is("the calls are named", unreadOf(noCalls), ["calls"]);

  part("Several at once, in the page's order");
  callsDown = true;
  const many = await failing([["HGETALL", "nl:imp:buy:"], ["GET", "nl:mail:flows:"]], () => buyerProfile(store, EMAIL));
  callsDown = false;
  is("each named once", unreadOf(many), ["imported", "calls", "sequences"]);

  part("The team's notes about them");
  const person = personKey(STATS, EMAIL);
  const notesKey = `nl:person:${STATS}:n:${person}`;
  const NOTE_ID = "0a1b2c3d";
  const written = JSON.stringify({ at: NOW - 10, by: "owner@example.com", text: "Asked about the advanced course." });
  await seed();
  is("no notes kept: an empty hash is no notes, read exactly", [await readPersonNotes(STATS, person), unreadOf(await buyerProfile(store, EMAIL))], [[], []]);
  await redis.pipeline([["HSET", notesKey, NOTE_ID, written]]);
  const withNote = await buyerProfile(store, EMAIL);
  is("a note kept is read, and nothing is named", [withNote.notes.map((n) => [n.id, n.at, n.by, n.text]), unreadOf(withNote)], [[[NOTE_ID, NOW - 10, "owner@example.com", "Asked about the advanced course."]], []]);

  /** Answers the notes' read with `reply` as the whole pipeline's answer; every other read as it is. */
  async function notesAnswer<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
    const original = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((c) => c[0] === "HGETALL" && c[1] === notesKey) ? reply : original.call(redis, commands)) as typeof redis.pipeline;
    try {
      return await run();
    } finally {
      redis.pipeline = original;
    }
  }
  const at = NOW - 10;
  const malformed: [string, unknown][] = [
    ["no reply at all", []],
    ["a nil, which HGETALL never answers", [null]],
    ["a text instead of a hash", ["notes"]],
    ["a number instead of a hash", [3]],
    ["an odd count: a field without its value", [[NOTE_ID]]],
    ["a value that is not text", [[NOTE_ID, 5]]],
    ["a field that is not a note's id", [["note-1", written]]],
    ["a value that is not JSON", [[NOTE_ID, "{"]]],
    ["a value that is JSON but not a record", [[NOTE_ID, "[1]"]]],
    ["a note with no words", [[NOTE_ID, JSON.stringify({ at, by: "owner@example.com", text: "  " })]]],
    ["a note whose words are not text", [[NOTE_ID, JSON.stringify({ at, by: "owner@example.com", text: 7 })]]],
    ["a note with no time", [[NOTE_ID, JSON.stringify({ by: "owner@example.com", text: "Hi" })]]],
    ["a note whose time is not a whole number of seconds", [[NOTE_ID, JSON.stringify({ at: "soon", by: "owner@example.com", text: "Hi" })]]],
    ["a note whose writer is not text", [[NOTE_ID, JSON.stringify({ at, by: 9, text: "Hi" })]]],
    ["a good note beside a broken one", [[NOTE_ID, written, "0a1b2c3e", "{"]]],
  ];
  for (const [what, reply] of malformed) {
    const read = await notesAnswer(reply, () => readPersonNotes(STATS, person).then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : String(error))));
    is(`${what}: reading the notes says it could not`, read, "unknown");
    const profile = await notesAnswer(reply, () => buyerProfile(store, EMAIL));
    is(`${what}: the page names the notes, shows none as if there were none, and keeps the rest`, [unreadOf(profile), profile.notes, profile.sequences], [["notes"], [], ["Welcome"]]);
  }
  const notesDown = await failing([["HGETALL", "nl:person:"]], () => buyerProfile(store, EMAIL));
  is("Redis not reached for the notes: they are named, the rest is there", [unreadOf(notesDown), notesDown.notes, notesDown.sequences], [["notes"], [], ["Welcome"]]);
  const notesAndCalls = await failing([["HGETALL", "nl:person:"], ["HGETALL", "nl:imp:buy:"]], () => buyerProfile(store, EMAIL));
  is("named last, in the page's order", unreadOf(notesAndCalls), ["imported", "notes"]);

  part("Adding or removing a note when the notes cannot be read");
  const added = await notesAnswer([["notes"]], () => addPersonNote(STATS, person, "owner@example.com", "Prefers email.", ROOM, (NOW + 5) * 1000).then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : String(error))));
  is("adding: the note is written, and the notes as they are after are said not read, never a short list", added, "unknown");
  const kept = await readPersonNotes(STATS, person);
  is("the note added is kept beside the one before", kept.map((n) => n.text), ["Prefers email.", "Asked about the advanced course."]);
  const removed = await notesAnswer([["notes"]], () => removePersonNote(STATS, person, NOTE_ID, ROOM).then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : String(error))));
  is("removing: said not read, and nothing is taken away", [removed, (await readPersonNotes(STATS, person)).length], ["unknown", 2]);

  part("What the page says");
  const words = (profiles as unknown as { profileUnreadWords?: (parts: string[]) => string }).profileUnreadWords;
  is("a sentence exists for the parts", typeof words, "function");
  if (typeof words === "function") {
    is("nothing missing, nothing said", words([]), "");
    is(
      "one part",
      words(["calls"]),
      "Some parts of this page could not be loaded just now, so they are missing below: their calls coming up. Nothing was changed. Open this page again in a moment.",
    );
    is(
      "several, and the totals warned about when money may be missing",
      words(["imported", "paypal", "sequences"]),
      "Some parts of this page could not be loaded just now, so they are missing below: purchases brought from another platform, given, bought for others or paid with PayPal; the amounts of their PayPal sales; and the sequences they were started on. What they paid may be more than the totals show. Nothing was changed. Open this page again in a moment.",
    );
    is(
      "the notes",
      words(["notes"]),
      "Some parts of this page could not be loaded just now, so they are missing below: your team's notes about them. Nothing was changed. Open this page again in a moment.",
    );
  }
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("the studio page shows the sentence as a status", /profile\.unread\.length[\s\S]{0,200}role="status"[\s\S]{0,200}profileUnreadWords\(profile\.unread\)/.test(page), true);
  const tilesBlock = page.slice(page.indexOf("const tiles = ["), page.indexOf("];", page.indexOf("const tiles = [")));
  is(
    "the purchase tiles never say \"nothing bought yet\" while purchases could not all be read",
    (tilesBlock.match(/"nothing bought yet"/g) ?? []).length === 2 && (tilesBlock.match(/purchasesUnread \? "purchases could not all be loaded" : "nothing bought yet"/g) ?? []).length === 2,
    true,
  );
  is("and purchasesUnread covers Stripe, the handed-over purchases and the PayPal amounts", /const purchasesUnread = profile\.stripeError \|\| profile\.unread\.includes\("imported"\) \|\| profile\.unread\.includes\("paypal"\);/.test(page), true);
  // WCAG 1.3.3 (AX274): the orders box is read on its own (a screen reader can jump to its heading), so its words
  // say what happened and what to do, never only "see the note above".
  const ordersSection = page.slice(page.indexOf('aria-labelledby="orders-title"'), page.indexOf("</section>", page.indexOf('aria-labelledby="orders-title"')));
  is(
    "Stripe not read: the orders box says why and what to do in its own words, without pointing above",
    [/\b(above|below)\b/i.test(ordersSection), ordersSection.includes('"Their purchases could not be loaded just now, because Stripe could not be read. Open this page again in a moment."')],
    [false, true],
  );
  const notesSection = page.slice(page.indexOf('aria-labelledby="notes-title"'), page.indexOf("</section>", page.indexOf('aria-labelledby="notes-title"')));
  is(
    "notes not read: the notes box (and its \"No notes yet.\") is not drawn; a status says they could not be loaded",
    /profile\.unread\.includes\("notes"\)\s*\?\s*\(?\s*<p[^>]*role="status"[^>]*>[^<]*could not be loaded just now[^<]*<\/p>\s*\)?\s*:\s*profile\.person\s*\?\s*<PersonNotes/.test(notesSection),
    true,
  );
  const route = readFileSync("app/api/store/person/route.ts", "utf8");
  is("the notes route answers 503, not \"did not save\", when the notes could not be read", /error instanceof UnknownReplyError\)\s*return Response\.json\(\{ ok: false, error: "unavailable" \}, \{ status: 503 \}\)/.test(route), true);
  const box = readFileSync("components/person-notes.tsx", "utf8");
  is("and the notes box says so, without saying it did not save", /answer\.error === "unavailable"[\s\S]{0,120}toast\("Your notes could not be loaded just now\. Open this page again in a moment to see whether that saved\."\)/.test(box), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
