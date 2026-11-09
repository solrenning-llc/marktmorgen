/**
 * 36 [F5], unit 2: the studio's check-in screen for an in-person event
 * (lib/ticket-door.ts, app/api/store/check-in/route.ts,
 * app/studio/check-in/page.tsx, components/ticket-check-in.tsx), through the
 * real route, session, team role and store, on the signed code and one-time
 * mark of unit 1 (lib/ticket-code.ts). A code is admitted once; one used
 * before, changed, made for another event or another store's, or past its
 * end, is refused and takes no mark; an answer that cannot be read refuses
 * entry and says "could not check" (rule 24). Each check-in is one of the
 * store's studio requests. No ticket is sold here and no money moves.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/check-in/route";
import { DOOR_HEADLINES, TicketCheckIn } from "@/components/ticket-check-in";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { PIN_HEADER } from "@/lib/studio-route";
import { CHECK_IN_REFUSALS, checkInKey, makeTicketCode } from "@/lib/ticket-code";
import { CHECK_IN_BODY_BYTES, MAX_CODE_CHARS, cleanCode, doorOutcome, isStoreEvent, storeTicketEvent } from "@/lib/ticket-door";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; outcome?: string; message?: string; ending?: string };

const OWNER = "synthetic-door-owner@example.com";
const OTHER = "synthetic-door-other@example.com";
const HELPER = "synthetic-door-helper@example.com";
const EDITOR = "synthetic-door-editor@example.com";

const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const codeFor = (event: string, ticket: string, expiresAt = nowSec() + 30 * DAY, now = Date.now()) => {
  const made = makeTicketCode({ event, ticket, expiresAt }, now);
  if (!made.ok) throw new Error(`no code: ${made.reason}`);
  return made.code;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "synthetic-door", "Synthetic Door", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_door", subscriptionId: "sub_door", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await claimHandle(OTHER, "synthetic-elsewhere", "Synthetic Elsewhere", "");
  const other = (await storeForEmail(OTHER))!;

  part("An event is one store's own");
  const event = storeTicketEvent(store, "workshop1")!;
  const otherEvent = storeTicketEvent(other, "workshop1")!;
  is("an event id is made for the store", typeof event === "string" && /^[a-z0-9]{6,32}$/.test(event), true);
  is("the same name in another store is another event", event === otherEvent, false);
  is("this store's event is its own", isStoreEvent(store, event), true);
  is("another store's event is not", isStoreEvent(store, otherEvent), false);
  is("a name that does not fit is refused, not cut", [storeTicketEvent(store, ""), storeTicketEvent(store, "Workshop 1"), storeTicketEvent(store, "x".repeat(21))], [null, null, null]);
  is("a store with no id has no events", [storeTicketEvent({ sid: "" }, "workshop1"), isStoreEvent({ sid: "" }, event)], [null, false]);
  is("anything else is not an event", [isStoreEvent(store, undefined), isStoreEvent(store, 7), isStoreEvent(store, `${event}x`.repeat(3))], [false, false, false]);

  part("What is typed at the door");
  const code = codeFor(event, "abcdefgh23456789");
  is("spaces, line breaks and capitals from a printed code are taken out", cleanCode(`  ${code.slice(0, 20).toUpperCase()}\n ${code.slice(20)} `), code);
  is("anything that is not text is no code", [cleanCode(undefined), cleanCode(42)], ["", ""]);
  is("a code longer than any code is not read", cleanCode("t".repeat(MAX_CODE_CHARS + 1)), "");
  is("each refusal has a door outcome", [doorOutcome("malformed"), doorOutcome("forged"), doorOutcome("wrong_event"), doorOutcome("expired"), doorOutcome("used"), doorOutcome("no_key"), doorOutcome("unknown")], ["invalid", "invalid", "invalid", "expired", "used", "unknown", "unknown"]);

  part("Through the studio's route");
  const ownerCookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie: ownerCookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/check-in", { method: "POST", headers: { "content-type": "application/json", [PIN_HEADER]: store.handle, ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply, cache: response.headers.get("cache-control") };
  };
  const marked = async (ev: string, ticket: string) => (await redisPipeline([["GET", checkInKey(ev, ticket)]]))[0] !== null;
  const studioUsed = async () => allowanceUsedExact((await storeForEmail(OWNER))!, "studio");

  const before = await studioUsed();
  const first = await post({ event, code });
  is("a good code is admitted", [first.status, first.body.ok, first.body.outcome], [200, true, "admitted"]);
  is("it says which code, by its last characters only", first.body.ending, code.slice(-6));
  is("never kept by a browser", first.cache, "private, no-store");
  is("the ticket is marked used", await marked(event, "abcdefgh23456789"), true);
  is("the check-in is one of the store's studio requests", (await studioUsed())! - before!, 1);
  const again = await post({ event, code });
  is("the same code again is already used", [again.status, again.body.outcome, again.body.message], [200, "used", CHECK_IN_REFUSALS.used]);

  const typed = codeFor(event, "typedtyped234567");
  const fromHand = await post({ event, code: ` ${typed.toUpperCase()} ` });
  is("a code typed with capitals and spaces is read", fromHand.body.outcome, "admitted");

  const forged = codeFor(event, "forgedforged2345").replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const forgedReply = await post({ event, code: forged });
  is("a changed code is invalid", [forgedReply.body.outcome, forgedReply.body.message], ["invalid", CHECK_IN_REFUSALS.forged]);
  is("and takes no mark", await marked(event, "forgedforged2345"), false);
  is("words that are not a code are invalid", (await post({ event, code: "hello" })).body.outcome, "invalid");

  const otherEventHere = storeTicketEvent(store, "dinner2")!;
  const elsewhere = await post({ event, code: codeFor(otherEventHere, "dinnerdinner2345") });
  is("a ticket for the store's other event is refused here", [elsewhere.body.outcome, elsewhere.body.message], ["invalid", CHECK_IN_REFUSALS.wrong_event]);
  is("and is still good at its own door", await marked(otherEventHere, "dinnerdinner2345"), false);

  const theirs = codeFor(otherEvent, "theirstheirs2345");
  is("another store's ticket is refused at this door", (await post({ event, code: theirs })).body.outcome, "invalid");
  const theirDoor = await post({ event: otherEvent, code: theirs });
  is("and this store cannot open another store's door", [theirDoor.status, theirDoor.body.error], [400, "event"]);
  is("so it cannot spend another store's ticket", await marked(otherEvent, "theirstheirs2345"), false);
  is("a door with no event is refused", (await post({ code })).status, 400);

  const madeAt = Date.now() - 3 * DAY * 1000;
  const old = codeFor(event, "oldoldoldold2345", Math.floor(madeAt / 1000) + DAY, madeAt);
  const expired = await post({ event, code: old });
  is("a code past its end is expired", [expired.body.outcome, expired.body.message], ["expired", CHECK_IN_REFUSALS.expired]);
  is("and takes no mark", await marked(event, "oldoldoldold2345"), false);

  part("An answer that cannot be read refuses entry (rule 24)");
  const unread = codeFor(event, "unreadunread2345");
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const key = String(commands[0]?.[1] ?? "");
    if (key.startsWith("nl:ticket:in:")) {
      if (commands[0][0] === "SET") return ["QUEUED"];
      throw new Error("synthetic: no answer");
    }
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  let unknown: Awaited<ReturnType<typeof post>>;
  try {
    unknown = await post({ event, code: unread });
  } finally {
    redis.pipeline = original;
  }
  is("it says it could not check, and to keep the door shut", [unknown.status, unknown.body.ok, unknown.body.outcome, unknown.body.message], [503, false, "unknown", CHECK_IN_REFUSALS.unknown]);
  is("never admitted", unknown.body.outcome === "admitted", false);
  const noKey = { data: process.env.NIMBUS_DATA_KEY, stripe: process.env.STRIPE_SECRET_KEY };
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  let keyless: Awaited<ReturnType<typeof post>>;
  try {
    keyless = await post({ event, code });
  } finally {
    if (noKey.data === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = noKey.data;
    if (noKey.stripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = noKey.stripe;
  }
  is("with no key in the environment it could not check either", [keyless.status, keyless.body.outcome], [503, "unknown"]);

  part("Who may check people in");
  const teamKey = `nl:team:${store.sid}`;
  const joinedAt = new Date().toISOString();
  await redisPipeline([["SET", teamKey, JSON.stringify({ members: [{ email: HELPER, role: "support", joinedAt }, { email: EDITOR, role: "editor", joinedAt }], invites: [] })]]);
  const helper = await post({ event, code: codeFor(event, "helperhelper2345") }, { cookie: `${SESSION_COOKIE}=${await openSession(HELPER)}` });
  is("support, who reads orders, checks people in", helper.body.outcome, "admitted");
  const editor = await post({ event, code: codeFor(event, "editoreditor2345") }, { cookie: `${SESSION_COOKIE}=${await openSession(EDITOR)}` });
  is("an editor, who does not, is refused", editor.status, 403);
  is("and takes no mark", await marked(event, "editoreditor2345"), false);
  is("signed out is refused", (await post({ event, code }, {})).status, 401);
  is("from another site is refused", (await post({ event, code }, { cookie: ownerCookie, origin: "https://elsewhere.example" })).status, 403);
  is("a body longer than a check-in is refused", (await post({ event, code: code + " ".repeat(CHECK_IN_BODY_BYTES) })).status, 413);

  part("The screen");
  const html = renderToStaticMarkup(createElement(TicketCheckIn, { event }));
  is("a labelled field for the code", /<label[^>]*for="check-in-code"[^>]*>Ticket code<\/label>/.test(html), true);
  is("the field says how to use it", html.includes('aria-describedby="check-in-code-hint"'), true);
  is("no spelling help or capitals forced on a code", ["autoCapitalize=\"none\"", "spellCheck=\"false\"", "autoComplete=\"off\""].every((a) => html.includes(a)), true);
  is("one clear action", (html.match(/<button/g) ?? []).length, 1);
  is("the button says what it does", />Check in<\/button>/.test(html), true);
  is("a status region the result is read from", /role="status"[^>]*aria-live="polite"/.test(html) || /aria-live="polite"[^>]*role="status"/.test(html), true);
  is("no time limit, no countdown", /countdown|seconds left|timer/i.test(html), false);
  is("every result says what to do at the door, in words, not by color", Object.values(DOOR_HEADLINES).every((line) => /^(Let them in|Do not let them in)/.test(line)), true);
  is("each outcome has its own headline", Object.keys(DOOR_HEADLINES).sort(), ["admitted", "expired", "invalid", "unknown", "used"]);
  is("could not check never reads as admitted", DOOR_HEADLINES.unknown.startsWith("Do not let them in"), true);

  const page = readFileSync("app/studio/check-in/page.tsx", "utf8");
  is("the page is for whoever reads orders, through the studio's own check", /studioView\([^)]*"orders"\)/.test(page), true);
  is("it draws the screen only for one of the store's own events", page.includes("isStoreEvent(store,"), true);
  const route = readFileSync("app/api/store/check-in/route.ts", "utf8");
  is("the route passes the studio's guard with the orders permission", /guardStoreWrite\(request, "orders", CHECK_IN_BODY_BYTES\)/.test(route), true);
  is("nothing here sells or charges", /checkout|stripe|price|payment/i.test(route + page), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
