/**
 * Counters read only in their exact shape (audit SG2, CX-123 rule 24; MR:
 * a ceiling before every cost). Five doors counted a request and compared
 * `Number(reply)` with their limit, so a reply that was missing, cut short or
 * of another shape opened them: `Number(undefined) > n` is false, and
 * `Number(null) <= n`, `Number(true) <= n`, `Number("") <= n` are true.
 *
 * Called as the site calls them, on the in-memory store, with only the
 * counter's own reply replaced:
 *
 *   - app/api/store/export/route.ts: the ten-minute window before a file of
 *     the store's numbers, and the count of whole-store files after a plan
 *     ended, never make the file on an unknown count;
 *   - app/api/store/licence/route.ts: the per-connection window before the
 *     store's licence check reads nothing of the store on an unknown count;
 *   - lib/letter-access.ts: asking for a link never schedules the email, and
 *     opening one never lets a browser in, on an unknown count; the open
 *     route (app/api/store/letters/open/route.ts) then answers 503 in the
 *     store's words, never a bare server error;
 *   - lib/assignment.ts takeRoom: an unknown INCRBY never takes the room for
 *     an upload, and never gives back (DECRBY) bytes it cannot say it took;
 *   - lib/community-events.ts withinEventWrites: an unknown count never lets
 *     a creator's change through.
 *
 * A confirmed count within the limit still lets each through, and a
 * confirmed count past it is still refused as before.
 */
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { GET as licenceRoute } from "@/app/api/store/licence/route";
import { GET as letterOpenRoute } from "@/app/api/store/letters/open/route";
import { createHash } from "node:crypto";
import { storeKey } from "@/lib/learn";
import { letterWords } from "@/lib/buyer-words/letters";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { requestLetterLink, spendLetterOpen } from "@/lib/letter-access";
import type { Letter } from "@/lib/letter-rules";
import { takeRoom } from "@/lib/assignment";
import { withinEventWrites } from "@/lib/community-events";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// A synthetic stand-in key, so the letter link reaches "sent" now that mail with no route says error (main, 8aa1f20a); see tests/resend-fixture-credentials.ts.
process.env.RESEND_API_KEY ??= "re_test_a_stand_in_key_for_tests_only";

type Command = (string | number)[];

/** Which pipeline is the counter's, the reply it gets instead of the real one ("throw": it never answers), and what came after it. */
let isCounter: (commands: Command[]) => boolean = () => false;
let counterReply: unknown = null;
let counterCalls = 0;
/** Every pipeline sent after the counter's, with its commands. */
let afterCounter: Command[][] = [];
let counted = false;

const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (!counted && isCounter(commands)) {
    counted = true;
    counterCalls++;
    if (counterReply === "throw") throw new Error("the database did not answer");
    if (counterReply !== null) return counterReply;
    return pipeline(commands);
  }
  if (counted) afterCounter.push(commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

function arm(match: (commands: Command[]) => boolean, reply: unknown): void {
  isCounter = match;
  counterReply = reply;
  counted = false;
  afterCounter = [];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A SET NX then INCR counter's replies that are not a count: each must refuse. */
const UNKNOWN_PAIRS: [string, unknown][] = [
  ["a SET answered false", [false, 1]],
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a count of zero", ["OK", 0]],
  ["a count that is true", ["OK", true]],
  ["a count that is not whole", ["OK", 1.5]],
  ["a count below zero", ["OK", -1]],
  ["a reply cut short", [0]],
  ["an empty reply", []],
  ["a reply that is not a list", { x: 1 }],
  ["a counter that never answers", "throw"],
];

/** The same, for a counter that also reads its TTL in the same round. */
const UNKNOWN_TRIPLES: [string, unknown][] = [
  ["a SET answered false", [false, 1, 3_600]],
  ["a count that is null", ["OK", null, 3_600]],
  ["a count written as text", ["OK", "1", 3_600]],
  ["a count of zero", ["OK", 0, 3_600]],
  ["a count that is true", ["OK", true, 3_600]],
  ["a reply cut short", ["OK", 1]],
  ["a count alone", [0]],
  ["an empty reply", []],
  ["a reply that is not a list", { x: 1 }],
  ["a TTL of another shape", ["OK", 1, "3600"]],
  ["a counter that never answers", "throw"],
];

async function settled<T>(work: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await work();
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  const OWNER = "numbergates@example.com";
  await claimHandle(OWNER, "numbergates", "Number Gates", "Recipes.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const made = await addProduct(OWNER, "Butter Club", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  /** A store whose plan has ended, a new one each time: its studio has a small daily bound of its own for downloading its data. */
  let endedStores = 0;
  const endedStore = async () => {
    const owner = `numbergatesended${++endedStores}@example.com`;
    await claimHandle(owner, `numbergatesended${endedStores}`, "Ended Gates", "Recipes.");
    await ensureStatsId(owner);
    await ensureStoreId(owner);
    await setSubscription(owner, { customerId: `cus_numbergatesended${endedStores}`, subscriptionId: `sub_numbergatesended${endedStores}`, active: false });
    return { ended: (await storeForEmail(owner))!, endedCookie: `${SESSION_COOKIE}=${await openSession(owner)}` };
  };

  const exportCall = async (what: string, who = store, jar = cookie) => {
    const response = await settled(() => exportRoute(new NextRequest(`https://marktmorgen.com/api/store/export?what=${what}`, { headers: { "x-nimbus-store": who.sid, cookie: jar } })));
    // A route that throws is a server error page: not a file, and not an honest answer either.
    if (response === "threw") return { status: 500, type: "", file: false, body: "threw" };
    return { status: response.status, type: response.headers.get("Content-Type") ?? "", file: (response.headers.get("Content-Disposition") ?? "").startsWith("attachment"), body: await response.text() };
  };

  part("The store's numbers as a file: the ten-minute window");
  const windowCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:rl:export:") && !String(commands[0][1]).includes(":ended:");
  for (const [label, reply] of UNKNOWN_PAIRS) {
    arm(windowCounter, reply);
    const before = counterCalls;
    const answer = await exportCall("visits");
    is(`${label}: no file, nothing read after the count, an honest answer`, [counterCalls - before, answer.file, answer.status, afterCounter.length, answer.body], [1, false, 502, 0, "Stripe or our records did not answer just now. Nothing is lost; try again in a moment."]);
  }
  arm(windowCounter, null);
  const visits = await exportCall("visits");
  is("a confirmed count within the window makes the file", [visits.status, visits.file], [200, true]);
  arm(windowCounter, [null, 11]);
  const busy = await exportCall("visits");
  is("a confirmed count past the window is refused as before", [busy.status, busy.file, busy.body.startsWith("That is a lot of files")], [429, false, true]);
  arm(windowCounter, ["OK", 1.5]);
  const storeFile = await exportCall("store");
  is("the whole store's file on an unknown window count: not made, said as not made", [storeFile.status, storeFile.file, storeFile.body], [503, false, "Your store's file could not be made just now. Try again in a minute."]);

  part("The whole store's file after a plan ended");
  const endedCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]).includes(":ended:");
  for (const [label, reply] of UNKNOWN_PAIRS) {
    arm(endedCounter, reply);
    const before = counterCalls;
    const { ended, endedCookie } = await endedStore();
    const answer = await exportCall("store", ended, endedCookie);
    is(`${label}: the file is not made`, [counterCalls - before, answer.file, answer.status, answer.body], [1, false, 503, "Your store's file could not be made just now. Try again in a minute."]);
  }
  const kept = await endedStore();
  arm(endedCounter, null);
  const endedFile = await exportCall("store", kept.ended, kept.endedCookie);
  is("a confirmed count within what an ended plan keeps makes the file", [endedFile.status, endedFile.file, endedFile.type.startsWith("application/json")], [200, true, true]);
  arm(endedCounter, [null, ENDED_STORE_EXPORTS + 1]);
  const endedPast = await exportCall("store", kept.ended, kept.endedCookie);
  is("a confirmed count past it is refused as before", [endedPast.status, endedPast.file, endedPast.body.startsWith("You have downloaded your store's main data")], [429, false, true]);

  part("The license check");
  const licenceCall = async () => {
    const response = await settled(() => licenceRoute(new NextRequest(`https://marktmorgen.com/api/store/licence?store=${store.handle}&product=${made.product.id}&key=ABCD-EFGH-IJKL-MNOP`, { headers: { "x-forwarded-for": "203.0.113.9" } })));
    if (response === "threw") return { status: 500, body: { error: "threw" } as { error?: string; status?: string } };
    return { status: response.status, body: (await response.json()) as { error?: string; status?: string } };
  };
  const licenceCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:rl:licence:");
  for (const [label, reply] of UNKNOWN_PAIRS) {
    arm(licenceCounter, reply);
    const before = counterCalls;
    const answer = await licenceCall();
    is(`${label}: nothing of the store is read, an honest answer`, [counterCalls - before, answer.status, answer.body.error, afterCounter.length], [1, 502, "Could not check right now.", 0]);
  }
  arm(licenceCounter, null);
  const checked = await licenceCall();
  is("a confirmed count within the window reaches the store's check", [checked.status !== 429 && checked.status !== 502, afterCounter.length > 0], [true, true]);
  arm(licenceCounter, [null, 121]);
  const tooMany = await licenceCall();
  is("a confirmed count past the window is refused as before", [tooMany.status, tooMany.body.error, afterCounter.length], [429, "Too many checks. Wait a minute.", 0]);

  part("A link to read an email kept for members");
  const letter: Letter = { id: "lt_numbergates1", sid: store.sid, subject: "Butter notes", body: "Words.", sentAt: Date.now(), publishedAt: Date.now(), products: [made.product.id] };
  const linkCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:letters:rl:");
  /** Whether the work after the answer (who holds the product, the link, its email) was started. */
  const emailWorkStarted = () => afterCounter.some((commands) => commands.some((command) => String(command[1] ?? "").startsWith("nl:letters:ok:") || String(command[1] ?? "").startsWith("nl:letters:link:")));
  let n = 0;
  const ask = () => settled(() => requestLetterLink({ store, letter, email: `reader${++n}@example.com`, ip: `198.51.100.${n % 250}`, origin: "https://marktmorgen.com" }));
  for (const [label, reply] of UNKNOWN_TRIPLES) {
    arm(linkCounter, reply);
    const before = counterCalls;
    const result = await ask();
    await tick();
    is(`${label}: not "sent", and no email work started`, [counterCalls - before, result === "sent", emailWorkStarted()], [1, false, false]);
  }
  arm(linkCounter, null);
  const sent = await ask();
  await tick();
  is("confirmed counts within the limits: sent, and the work after the answer starts", [sent, emailWorkStarted()], ["sent", true]);
  arm(linkCounter, [null, 1_000, 3_000]);
  const limited = await ask();
  await tick();
  is("a confirmed count past the limit is refused as before", [limited, emailWorkStarted()], ["limited", false]);

  part("Opening an emailed link");
  const token = "ab".repeat(32);
  const opensCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]).endsWith(":opens");
  for (const [label, reply] of UNKNOWN_TRIPLES) {
    arm(opensCounter, reply);
    const before = counterCalls;
    const opened = await settled(() => spendLetterOpen(token));
    is(`${label}: the link does not let a browser in`, [counterCalls - before, opened === true], [1, false]);
  }
  arm(opensCounter, null);
  is("a confirmed count within the opens lets it in", await spendLetterOpen(token), true);
  arm(opensCounter, [null, 11, 3_000]);
  is("a confirmed count past the opens is refused as before", await spendLetterOpen(token), false);

  part("Opening an emailed link, through the route");
  // A real link, kept as the route reads it, for this store; the opens counter alone does not answer.
  const routeToken = "cd".repeat(32);
  const grantKey = `nl:letters:link:${createHash("sha256").update(`nimbus-letter:${routeToken}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", grantKey, JSON.stringify({ e: "reader@example.com", k: storeKey(store), h: store.handle, l: "0123456789abcdef0123" })]]);
  const openCall = async () => {
    const response = await settled(() => letterOpenRoute(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${routeToken}`)));
    if (response === "threw") return { status: 500, body: "threw", cookie: false };
    return { status: response.status, body: await response.text(), cookie: (response.headers.get("Set-Cookie") ?? "") !== "" };
  };
  for (const [label, reply] of UNKNOWN_TRIPLES) {
    arm(opensCounter, reply);
    const answer = await openCall();
    is(`${label}: the route says, in the store's words, to try again, and lets no browser in`, [answer.status, answer.body, answer.cookie], [503, letterWords(store.language).linkBusy, false]);
  }
  arm(opensCounter, null);
  const let_in = await openCall();
  is("a confirmed count within the opens still lets the browser in", [let_in.status, let_in.cookie], [303, true]);
  arm(opensCounter, [null, 11, 3_000]);
  const used = await openCall();
  is("a confirmed count past the opens is still gone, as before", [used.status, used.body], [410, letterWords(store.language).linkGone]);

  part("Room for a handed-in file");
  const room = "numbergatesroom";
  const roomCounter = (commands: Command[]) => commands[0]?.[0] === "INCRBY" && String(commands[0][1]).endsWith(`:${room}`);
  const UNKNOWN_BYTES: [string, unknown][] = [
    ["a total that is null", [null]],
    ["a total written as text", ["100"]],
    ["a total of zero", [0]],
    ["a total that is true", [true]],
    ["a total below the bytes just added", [99]],
    ["a total that is not whole", [100.5]],
    ["a reply with one too many", [100, 1]],
    ["an empty reply", []],
    ["a reply that is not a list", { x: 1 }],
    ["a counter that never answers", "throw"],
  ];
  for (const [label, reply] of UNKNOWN_BYTES) {
    arm(roomCounter, reply);
    const before = counterCalls;
    const took = await settled(() => takeRoom(room, 100, 1_000));
    const gaveBack = afterCounter.some((commands) => commands.some((command) => command[0] === "DECRBY"));
    is(`${label}: the room is not taken, and nothing that may not have entered is given back`, [counterCalls - before, took === true, gaveBack], [1, false, false]);
  }
  arm(roomCounter, null);
  is("a confirmed total within the room takes it", await takeRoom(room, 100, 1_000), true);
  arm(roomCounter, [1_001]);
  const full = await takeRoom(room, 100, 1_000);
  is("a confirmed total past the room is refused and given back as before", [full, afterCounter.some((commands) => commands.some((command) => command[0] === "DECRBY"))], [false, true]);

  part("A creator's changes to live events");
  const community = "cmnumbergates";
  const eventCounter = (commands: Command[]) => commands[0]?.[0] === "SET" && String(commands[0][1]) === `nl:rl:cm:ev:${community}`;
  for (const [label, reply] of UNKNOWN_PAIRS) {
    arm(eventCounter, reply);
    const before = counterCalls;
    const allowed = await settled(() => withinEventWrites(community));
    is(`${label}: the change is not let through`, [counterCalls - before, allowed === true], [1, false]);
  }
  arm(eventCounter, null);
  is("a confirmed count within the hour lets it through", await withinEventWrites(community), true);
  arm(eventCounter, [null, 1_000]);
  is("a confirmed count past the hour is refused as before", await withinEventWrites(community), false);

  arm(() => false, null);
  done();
}

void main();
