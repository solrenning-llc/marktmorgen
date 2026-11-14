/**
 * The call diary's busy hash is read only in its exact shape (rule 24, Claude 6, 06/11/2026).
 *
 * lib/calls.ts heldAndBooked used to read the busy hash's HGETALL reply with
 * `Array.isArray(raw) ? raw : []`, so a reply in another shape was taken for
 * "nothing held or booked": the booking page offered a held time again, a
 * second buyer opened a second checkout for a one-seat call, and both became
 * bookings at the same start. A value that did not parse was taken for a
 * stale hold and HDEL'd, deleting a real hold for good. The proof is
 * tests/held-booked-unknown.proof.ts on claude6/held-booked-proof @ b8019792.
 *
 * Here, on synthetic records with Stripe and the email service mocked:
 *   - a confirmed empty hash and a healthy one read as before;
 *   - every other shape of the reply, and every value that is not a JSON
 *     object with a numeric `e` and `until`, is unknown: busyTimes throws
 *     UnknownReplyError, the booking page says it cannot read the times,
 *     holdAndCheckout, checkCallChange and moveBooking (on its reading of
 *     the taken times) answer "error",
 *     slotsForMove answers null and releaseOwnHold refuses, and nothing is
 *     HDEL'd or opened at Stripe;
 *   - a hold read whole and genuinely run out is still tidied.
 */
import type { CallSetup } from "@/lib/call-setup";
import { busyTimes, checkCallChange, confirmBooking, holdAndCheckout, moveBooking, releaseOwnHold, slotsForMove, slotsForProduct, type CallListing } from "@/lib/calls";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import type { Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const opened: string[] = [];
const expired: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    const id = `cs_test_hab${String(opened.length + 1).padStart(14, "0")}`;
    opened.push(id);
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const closing = method === "POST" ? /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path) : null;
  if (closing) {
    expired.push(decodeURIComponent(closing[1]));
    return answer({ status: "expired" });
  }
  // Stripe's list of paid sessions is empty: a hold is an open, unpaid checkout, known only to the busy hash.
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
// The same hours in person: a change of kind, which checkCallChange checks against the diary.
const inPerson = { ...weekly, place: { lines: ["Bela Studio", "12 Harbor Street, Portland, ME 04101"] } } as unknown as CallSetup;

const real = redis.pipeline.bind(redis);
let busyHash = "";
/**
 * Answers the busy hash's HGETALL with `shape(healthy reply)`, every other command as Redis would. With `only`, just
 * the HGETALLs of the busy hash counted from one whose number is in it are changed.
 */
function patch(shape: (healthy: unknown) => unknown, wholePipeline?: (answers: unknown[], commands: Command[]) => unknown, only?: number[]): void {
  let seen = 0;
  redis.pipeline = async (commands: Command[]) => {
    const answers = await real(commands);
    const ours = commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === busyHash;
    if (ours) seen += 1;
    if (only && !(ours && only.includes(seen))) return answers as never;
    if (ours && wholePipeline) return wholePipeline(answers, commands) as never;
    return answers.map((answer, i) => (commands[i][0] === "HGETALL" && commands[i][1] === busyHash ? shape(answer) : answer)) as never;
  };
}
const restore = () => {
  redis.pipeline = real;
};
const fields = async () => (await real([["HKEYS", busyHash]]))[0];
async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return "no throw";
  } catch (error) {
    return (error as Error).name;
  }
}

async function setUp(): Promise<{ store: Store; listing: CallListing; full: Product & { call: CallSetup } }> {
  const OWNER = "mira@example.com";
  await claimHandle(OWNER, "mira", "Mira Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMira00001", true);
  await setSubscription(OWNER, { customerId: "cus_mira00001", subscriptionId: "sub_mira00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  busyHash = `nl:call:busy:${store.callsId}`;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  return { store, listing, full };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_held_booked_only";
  process.env.RESEND_API_KEY = "re_test_held_booked_only";

  const { store, listing, full } = await setUp();
  const at = weekdayAt(3, 600);
  const offered = async () => {
    const read = await slotsForProduct(store, listing);
    return read === null ? "unreadable" : read.days.some((d) => d.starts.includes(at));
  };
  const hold = () => holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });

  part("Controls: a confirmed empty hash and a healthy one read as before");
  is("confirmed empty hash: nothing busy, the time offered", [await busyTimes(store), await offered()], [[], true]);
  const first = await hold();
  if (!first.ok) throw new Error(`no first hold: ${first.reason}`);
  is("buyer A holds the one seat: one entry in the hash", await fields(), [first.session]);
  is("healthy hash with the hold: the time is busy and not offered", [(await busyTimes(store)).map((b) => [b.start, b.session]), await offered()], [[[at, first.session]], false]);
  is("healthy hash: buyer B is refused the held time", await hold(), { ok: false, reason: "taken" });
  is("healthy hash: no second checkout was opened", opened.length, 1);
  is("healthy hash: a change of kind is refused while the time is held", await checkCallChange(store, listing.id, inPerson), "kind");

  part("Each unknown shape of the HGETALL reply is unknown, never nothing busy");
  const shapes: [string, (healthy: unknown) => unknown, ((answers: unknown[]) => unknown)?][] = [
    ["no reply (pipeline answers [])", (h) => h, () => []],
    ["an extra reply after the hash", (h) => h, (answers) => [...answers, "extra"]],
    ["null", () => null],
    ["a text", () => "OK"],
    ["a number", () => 2],
    ["an object {field: value}", (h) => Object.fromEntries([[(h as string[])[0], (h as string[])[1]]])],
    ["odd-length list cut to its field", (h) => [(h as string[])[0]]],
    ["odd-length list with a trailing orphan", (h) => [...(h as string[]), "orphan"]],
    ["a non-string value (number)", (h) => [(h as string[])[0], 7]],
    ["a null value", (h) => [(h as string[])[0], null]],
    ["a value that is an object", (h) => [(h as string[])[0], { not: "a string" }]],
  ];
  for (const [name, shape, whole] of shapes) {
    patch(shape, whole);
    const busy = await thrown(() => busyTimes(store));
    const page = await offered();
    restore();
    is(`${name}: busyTimes throws UnknownReplyError and the page says it cannot read the times`, [busy, page], ["UnknownReplyError", "unreadable"]);
  }
  is("the hold is still in the hash after every shape above", await fields(), [first.session]);

  part("Each value that is not a whole entry is unknown, kept, never taken for a stale hold");
  const values: [string, string][] = [
    ["a text that is not JSON", "not json {"],
    ["JSON null", "null"],
    ["a JSON list", "[]"],
    ["a JSON number", "7"],
    ["an object with no until", JSON.stringify({ s: at, e: at + 1_800_000, session: "cs_test_noUntil000000001" })],
    ["an object with a text e", JSON.stringify({ s: at, e: String(at + 1_800_000), until: 0, session: "cs_test_textEnd000000001" })],
    ["an object with a text start", JSON.stringify({ s: String(at), e: at + 1_800_000, until: 0, session: "cs_test_textStart0000001" })],
  ];
  for (const [name, value] of values) {
    await real([["HSET", busyHash, "cs_test_broken0000000001", value]]);
    const busy = await thrown(() => busyTimes(store));
    const page = await offered();
    const kept = ((await fields()) as string[]).includes("cs_test_broken0000000001");
    await real([["HDEL", busyHash, "cs_test_broken0000000001"]]);
    is(`${name}: unknown (UnknownReplyError, page unreadable), and the field is kept, not HDEL'd`, [busy, page, kept], ["UnknownReplyError", "unreadable", true]);
  }
  is("the real hold is untouched", await fields(), [first.session]);

  part("Buyer B cannot take the held time while the reply is unknown");
  patch(() => null);
  const second = await hold();
  restore();
  is("holdAndCheckout's check inside the lock refuses: error, nothing held", second, { ok: false, reason: "error" });
  is("no second Stripe checkout is opened", opened.length, 1);
  patch((h) => [(h as string[])[0], { not: "a string" }]);
  const third = await hold();
  restore();
  is("a value that is an object: refused too, and no checkout", [third, opened.length], [{ ok: false, reason: "error" }, 1]);
  is("…and the real hold is not HDEL'd", await fields(), [first.session]);
  is("healthy again: buyer B is refused the held time as taken", await hold(), { ok: false, reason: "taken" });
  is("still one checkout for the one seat", opened.length, 1);

  part("checkCallChange, releaseOwnHold, slotsForMove and moveBooking refuse on an unknown reply");
  patch(() => "OK");
  const change = await checkCallChange(store, listing.id, inPerson);
  restore();
  is("checkCallChange: error, never a change let through over a held time", change, "error");
  patch(() => null);
  const release = await thrown(() => releaseOwnHold(store, first.session));
  restore();
  is("releaseOwnHold: refuses (UnknownReplyError), never skips quietly", release, "UnknownReplyError");
  is("…no checkout is closed at Stripe and the hold is kept", [expired, await fields()], [[], [first.session]]);

  await confirmBooking({ store, product: listing, session: first.session, start: at, end: at + 30 * 60_000, buyerEmail: "ann@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
  const booked = (await busyTimes(store)).filter((b) => b.start === at);
  is("buyer A pays: one booking at the start", booked.map((b) => b.session), [first.session]);
  const later = weekdayAt(3, 660);
  const move = () =>
    moveBooking({ store, product: listing, session: first.session, booked: { start: at, end: at + 30 * 60_000, email: "ann@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  patch(() => [first.session]);
  const offer = await slotsForMove(store, listing, first.session, at, 30 * 60_000);
  restore();
  is("slotsForMove: null (cannot read the times), never every time offered", offer, null);
  patch(() => 2);
  const moved = await move();
  restore();
  is("moveBooking, unknown on the diary read: error", moved, { ok: false, reason: "error" });
  // Healthy for the check, unknown only on the read of the entries the move replaces. That read comes after the move is
  // written (lib/calls.ts on main since #3240, held by tests/calls-lock-shape.test.ts): it is tidying only, so the move
  // is done and nothing is deleted on the reply it could not read.
  patch(() => null, undefined, [2]);
  const movedLate = await move();
  restore();
  is("moveBooking, unknown on the entries it replaces, read after the move is written: the move is done", movedLate.ok ? [movedLate.start, movedLate.moves] : movedLate, [later, 1]);
  is("…and the diary holds it at the new time only", (await busyTimes(store)).map((b) => [b.start, b.session]), [[later, first.session]]);

  part("A hold read whole and genuinely run out is still tidied");
  const ranOut = JSON.stringify({ s: at, e: at + 1_800_000, until: Date.now() - 60_000, session: "cs_test_ranOut0000000001", p: listing.id });
  await real([["HSET", busyHash, "cs_test_ranOut0000000001", ranOut]]);
  is("a hold that ran out is not busy", (await busyTimes(store)).map((b) => b.session), [first.session]);
  is("…and is HDEL'd, the booking kept", await fields(), [first.session]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
