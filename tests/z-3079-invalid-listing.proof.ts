/**
 * The booking calendar's making reads its call listings and its bookings'
 * rooms with MGETs in chunks, not one GET a key (cost review, option O5):
 * Upstash bills every command of a pipeline, and an MGET of many keys is one.
 *
 * Measured through the feed's own route, with a store at MAX_PRODUCTS call
 * listings (none on the record's first page, so every one is read) and
 * CALENDAR_CALLS bookings, each at its own time in a product that makes video
 * rooms (so every booking's four room reads and its room's making are sent).
 * And an MGET reply that is not whole, or holds anything but text or nothing,
 * fails the making as an unknown: never a listing or a room taken for absent.
 */
import { createHash } from "node:crypto";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import { newFeedToken } from "@/lib/calendar-sync";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { KIND } from "@/lib/catalog";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "batched@example.com";
const CATALOG = "a".repeat(32);
const CALLS_ID = "b".repeat(32);
const LISTING_KEY = /^nl:catalog:[0-9a-f]{32}:l:/;

/** Booked calls the stand-in for Stripe lists. */
let callSessions: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const data = String(input).includes("/checkout/sessions") ? callSessions : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }));
}) as typeof fetch;

type Batch = (string | number)[][];
/** What the database is sent while `work` runs: every command, and each command's name. */
async function counted<T>(work: () => Promise<T>, alter?: (batch: Batch, replies: unknown[]) => unknown[]) {
  const real = redis.pipeline;
  const sent: Batch = [];
  redis.pipeline = async (batch: Batch) => {
    sent.push(...batch);
    const replies = await real(batch);
    return alter ? alter(batch, replies) : replies;
  };
  try {
    return { value: await work(), sent };
  } finally {
    redis.pipeline = real;
  }
}

const WEEK = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const productId = (i: number) => `call${String(i).padStart(5, "0")}`;
const listing = (i: number) => ({
  id: productId(i), title: `Call ${i}`, priceCents: 5000, createdAt: "2026-11-01T00:00:00.000Z",
  call: { kind: "weekly", minutes: 30, tz: "UTC", weekly: WEEK, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: null, video: true, meet: null, seats: 1, sessions: [] },
});

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_batched_only_a_stand_in";
  await claimHandle(OWNER, "batched", "Batched Calls", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBatched001", true);
  await setSubscription(OWNER, { customerId: "cus_Batched0001", subscriptionId: "sub_Batched0001", active: true, tier: "pro", period: paidPeriod() });
  // MAX_PRODUCTS call listings, kept in their own records (none on the first page), and the store's calls id.
  const ownerKey = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${OWNER.toLowerCase()}`).digest("hex").slice(0, 40)}`;
  const record = JSON.parse(String(redis.run(["GET", ownerKey])));
  const items = Array.from({ length: 2 }, (_, i) => [productId(i), KIND.call | KIND.paid]);
  redis.run(["SET", ownerKey, JSON.stringify({ ...record, callsId: CALLS_ID, catalog: { id: CATALOG, items, head: [] } })]);
  for (let i = 0; i < 2; i += 1) redis.run(["SET", `nl:catalog:${CATALOG}:l:${productId(i)}`, JSON.stringify(listing(i))]);
  const store = (await storeForEmail(OWNER))!;

  const url = (await newFeedToken(store)).subscribeUrl ?? "";
  const token = url.slice(url.lastIndexOf("/") + 1);
  const ask = () => feedRoute(new Request(url), { params: Promise.resolve({ token }) });
  // CALENDAR_CALLS bookings, each at its own time, each in a product that makes rooms: every room read and made.
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  callSessions = Array.from({ length: 1 }, (_, i) => ({
    id: `cs_test_batched${String(i).padStart(6, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 3_600, amount_total: 5000, currency: "usd", customer_details: { email: `b${i}@example.com`, name: `B ${i}` },
    metadata: { store: store.handle, kind: "call", product: productId(i % MAX_PRODUCTS), start: String(hour + (i + 24) * 3_600_000), end: String(hour + (i + 24) * 3_600_000 + 1_800_000) },
    payment_intent: { id: `pi_${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }));
  const fresh = () => {
    redis.run(["DEL", `nl:cal:out:${store.statsId}`, `nl:cal:pace:${store.statsId}`]);
    for (const suffix of ["", ":a", ":r", ":c"]) redis.run(["DEL", `nl:cal:builds:${store.statsId}:${new Date().toISOString().slice(0, 10)}${suffix}`]);
  };

  part("Known call controls before unknown listings");
  fresh();
  const res = await ask(); const ics=await res.text();
  is("healthy: one event and the original room", [res.status,ics.includes("Call 0"),ics.includes("LOCATION:https://meet.jit.si/")],[200,true,true]);
  for(const [label,raw] of [["malformed JSON","{broken"],["valid JSON not a listing","{}"],["another listing under this id",JSON.stringify(listing(1))]]) {
    fresh();
    const response=await counted(ask,(batch,replies)=>batch.map((c,i)=> c[0]==="GET" && c[1]===`nl:catalog:${CATALOG}:l:${productId(0)}` ? raw : c[0]==="MGET" && LISTING_KEY.test(String(c[1])) && Array.isArray(replies[i]) ? (replies[i] as unknown[]).map((v,k)=> c[k+1]===`nl:catalog:${CATALOG}:l:${productId(0)}` ? raw:v):replies[i]));
    const text=await response.value.text();
    const cached=redis.run(["GET",`nl:cal:out:${store.statsId}`]);
    console.log("OBSERVED",label,JSON.stringify({status:response.value.status,missingLabel:text.includes("no longer listed"),room:text.includes("LOCATION:"),kept:cached!==null,commands:response.sent.length}));
    is(label+": unknown must not become gone/cached without room",[response.value.status,text.includes("BEGIN:VCALENDAR"),cached!==null],[503,false,false]);
  }
  done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
