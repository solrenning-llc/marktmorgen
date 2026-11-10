/**
 * Mail from a store switched off after notices about its content (`store.suspended`, lib/takedown.ts).
 *
 * - Product updates (lib/product-updates.ts) are the creator's own words sent to every buyer, from the store's
 *   monthly emails: they wait while the store is off. A new one is refused before anything is read or written; one
 *   already queued is held with nothing reserved, sent or counted, keeps its place and goes out once the store is back
 *   on. A switch-off value that is not "" (on) holds it too (rule 24).
 * - Call reminders (lib/call-reminders.ts) are what a buyer needs for a call they paid for: they are kept, and carry
 *   only the booking's own details (its time, its room, its calendar file and the buyer's page to move it).
 *
 * Against the real code, with the in-memory Redis and stand-ins for Stripe and the email service; synthetic only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { type CallListing, holdAndCheckout } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import {
  type Product,
  type Store,
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  noteTakedown,
  setMailSettings,
  setProductCall,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  storeForHandle,
} from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NY = "America/New_York";
const DAY = 86_400_000;

/** What the stand-in email service was asked to send: one entry an email, single or in a batch. */
const mailed: { to: string; subject: string; text: string }[] = [];
/** Paid checkouts the stand-in Stripe lists. */
const rows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
let sessions = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const list = Array.isArray(body) ? body : [body];
    for (const m of list) mailed.push({ to: Array.isArray(m.to) ? m.to.join(",") : String(m.to), subject: String(m.subject ?? ""), text: String(m.text ?? "") });
    return Response.json(Array.isArray(body) ? { data: list.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) } : { id: "synthetic" });
  }
  if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_offmail${String(sessions).padStart(10, "0")}`;
    const form = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...form].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return Response.json({ object: "list", data: rows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return Response.json(rows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

function reset() {
  redis.clear();
  mailed.length = 0;
  rows.length = 0;
  heldMeta.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_switched_off_mail";
  // A literal the synthetic email fixture knows (tests/resend-fixture-credentials.ts).
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
}

// ------------------------------------------------------------------ product updates

const owner = "offmail-owner@example.test";
const buyer = "offmail-buyer@example.test";

async function updateStore() {
  reset();
  await claimHandle(owner, "offmail", "Off Mail", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestOffMail001", true);
  await setSubscription(owner, { customerId: "cus_OffMail", subscriptionId: "sub_OffMail", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Off Mail", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Field guide", "", "27", null);
  assert.ok(made.ok);
  await setProductLink(owner, made.product.id, "https://example.com/guide");
  rows.push({
    id: "cs_offmail_update", object: "checkout.session", status: "complete", payment_status: "paid",
    created: Math.floor(Date.now() / 1000) - 86_400, amount_total: 2700, currency: "usd",
    customer_details: { email: buyer }, metadata: { store: "offmail", product: made.product.id },
  });
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, made.product.id))!;
  return { shop, product };
}

const queued = (id: string) => redis.run(["SISMEMBER", "nl:updq", id]);
const recipients = (id: string) => redis.run(["LRANGE", `nl:upd:job:${id}:to`, 0, -1]);
const toBuyer = () => mailed.filter((m) => m.to === buyer);

test("product update control: a store that is on sends it to its buyer", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  const out = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([out?.status, out?.done, out?.sent, toBuyer().length], ["sent", 1, 1, 1]);
});

test("product update: a switched-off store starts none, reading and writing nothing", async () => {
  const { product } = await updateStore();
  await noteTakedown(owner, null, true);
  const off = (await storeForEmail(owner))!;
  assert.ok(off.suspended);
  let stripeReads = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "api.stripe.com") stripeReads += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const started = await startUpdate(off, product, "A new chapter");
    assert.deepEqual(started, { ok: false, reason: "switched_off" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(stripeReads, 0);
  // No claim on the week's gap, no latest send, nothing queued.
  assert.equal(redis.run(["EXISTS", `nl:upd:last:${off.statsId}:${product.id}`]), 0);
  assert.equal(redis.run(["EXISTS", `nl:upd:latest:${off.statsId}:${product.id}`]), 0);
  assert.equal(redis.run(["SCARD", "nl:updq"]), 0);
  assert.equal(mailed.length, 0);
});

test("product update: one queued before the switch-off waits, then goes out once the store is back on", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  const before = await usedThisMonth(shop.listId, windowId(shop));
  await noteTakedown(owner, null, true);
  const held = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([held?.status, held?.done, held?.sent], ["waiting", 0, 0]);
  assert.match(held?.note ?? "", /switched off after notices about its content/);
  assert.match(held?.note ?? "", /Nothing more was sent/);
  assert.equal(toBuyer().length, 0);
  assert.equal(await usedThisMonth(shop.listId, windowId(shop)), before);
  assert.equal(queued(started.job.id), 1);
  assert.deepEqual(recipients(started.job.id), [buyer]);
  // Held again on the next run, still nothing sent.
  const again = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([again?.status, again?.done, again?.sent, toBuyer().length], ["waiting", 0, 0, 0]);
  await noteTakedown(owner, null, false);
  const back = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([back?.status, back?.done, back?.sent, back?.note, toBuyer().length], ["sent", 1, 1, "", 1]);
  assert.equal(queued(started.job.id), 0);
});

test("product update: a switch-off value that is not plainly on holds it too (rule 24)", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  const unknownOff = async (handle: string): Promise<Store | null> => {
    const read = await storeForHandle(handle);
    return read ? { ...read, suspended: "unknown" } : null;
  };
  const held = await advanceUpdate(started.job.id, unknownOff, Date.now() + 20_000);
  assert.deepEqual([held?.status, held?.done, held?.sent, toBuyer().length, queued(started.job.id)], ["waiting", 0, 0, 0, 1]);
  assert.equal((await startUpdate({ ...shop, suspended: "unknown" }, product, "")).ok, false);
});

/** Moves a send's start back by `days`, as if that many days had passed since it was queued. */
function ageJob(id: string, days: number) {
  const raw = JSON.parse(String(redis.run(["GET", `nl:upd:job:${id}`])));
  redis.run(["SET", `nl:upd:job:${id}`, JSON.stringify({ ...raw, createdAt: raw.createdAt - days * 86_400 }), "EX", 86_400]);
}

test("product update: a send held by the switch-off ends after its 60 days even while the store stays off, and never goes out after", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  await noteTakedown(owner, null, true);
  // Day 59: still within its 60 days, so it keeps waiting.
  ageJob(started.job.id, 59);
  const held = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([held?.status, queued(started.job.id)], ["waiting", 1]);
  // Day 61: its 60 days are over (the recipient list's own life ends with them).
  ageJob(started.job.id, 2);
  redis.run(["DEL", `nl:upd:job:${started.job.id}:to`]);
  const ended = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual(
    [ended?.status, ended?.done, ended?.sent, ended?.note, queued(started.job.id)],
    ["failed", 0, 0, "The recipient list expired. Nothing more was sent.", 0],
  );
  // The store comes back on afterward: nothing goes out and the send stays ended.
  await noteTakedown(owner, null, false);
  const after = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([after?.status, queued(started.job.id), toBuyer().length], ["failed", 0, 0]);
});

test("product update: a send past its 60 days ends even if its recipient list is somehow still there, sending nothing", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  await noteTakedown(owner, null, true);
  ageJob(started.job.id, 61);
  const ended = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.deepEqual([ended?.status, queued(started.job.id), redis.run(["EXISTS", `nl:upd:job:${started.job.id}:to`])], ["failed", 0, 0]);
  await noteTakedown(owner, null, false);
  await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.equal(toBuyer().length, 0);
});

test("product update: a send waiting for a plan with email also ends after its 60 days", async () => {
  const { shop, product } = await updateStore();
  const started = await startUpdate(shop, product, "A new chapter");
  assert.ok(started.ok, JSON.stringify(started));
  const noMail = async (handle: string): Promise<Store | null> => {
    const read = await storeForHandle(handle);
    return read ? { ...read, mail: null } : null;
  };
  const waiting = await advanceUpdate(started.job.id, noMail, Date.now() + 20_000);
  assert.deepEqual([waiting?.status, queued(started.job.id)], ["waiting", 1]);
  assert.match(waiting?.note ?? "", /Your plan does not include email/);
  ageJob(started.job.id, 61);
  redis.run(["DEL", `nl:upd:job:${started.job.id}:to`]);
  const ended = await advanceUpdate(started.job.id, noMail, Date.now() + 20_000);
  assert.deepEqual([ended?.status, ended?.note, queued(started.job.id), toBuyer().length], ["failed", "The recipient list expired. Nothing more was sent.", 0, 0]);
});

// ------------------------------------------------------------------ call reminders

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

test("call reminder: a switched-off store still reminds the buyer of a paid call, with only the booking's own details", async () => {
  reset();
  const creator = "offcall-owner@example.test";
  const caller = "offcall-buyer@example.test";
  await claimHandle(creator, "offcall", "Off Call", "");
  await ensureStatsId(creator);
  await setStripeAccount(creator, "acct_1TestOffCall001", true);
  await setSubscription(creator, { customerId: "cus_OffCall", subscriptionId: "sub_OffCall", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(creator, "Strategy call", "", "120", null);
  assert.ok(made.ok);
  await setProductCall(creator, made.product.id, weekly);
  const shop = (await storeForEmail(creator))!;
  const call = (await readListing(shop, made.product.id)) as CallListing;
  const start = weekdayAt(3, 600);
  const full = (await readProduct(shop, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store: shop, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  assert.ok(held.ok, JSON.stringify(held));
  rows.push({
    id: held.session, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 12_000, currency: "usd",
    customer_details: { email: caller }, metadata: heldMeta.get(held.session),
  });
  await noteTakedown(creator, null, true);
  assert.ok((await storeForHandle("offcall"))?.suspended);
  const member = reminderMember(shop.callsId!, "offcall", held.session, "24", start);
  redis.run(["ZADD", REMINDER_QUEUE, Date.now() - 1000, member]);
  const counts = await sendCallReminders(storeForHandle, Date.now() + 30_000, "https://marktmorgen.com");
  assert.equal(counts.reminded, 1);
  const toCaller = mailed.filter((m) => m.to === caller);
  assert.equal(toCaller.length, 1);
  // The room link stands as a whole word, never as a part of another address.
  assert.ok(toCaller[0].text.split(/\s+/).includes("https://example.com/room"));
  assert.match(toCaller[0].text, /\/api\/store\/ics\?handle=offcall/);
  // Every link to the store goes to this booking's own page (moving it), never to the store's switched-off pages.
  for (const link of toCaller[0].text.match(/https:\/\/marktmorgen\.com\/@offcall[^\s]*/g) ?? []) {
    assert.match(link, new RegExp(`^https://marktmorgen\\.com/@offcall/book/${call.id}\\?move=`));
  }
  assert.equal(mailed.filter((m) => m.to === creator).length, 1);
  assert.equal(redis.run(["ZSCORE", REMINDER_QUEUE, member]), null);
});
