/** R2 return: actual persisted move and real email path, with synthetic transport only. */
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { moveBooking, type CallListing } from "@/lib/calls";
import { movedKey } from "@/lib/call-records";
import type { CallSetup } from "@/lib/call-setup";
import { bookingWords } from "@/lib/buyer-words/booking";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const pipeline = redis.pipeline.bind(redis), priorFetch = globalThis.fetch;
const priorStripe = process.env.STRIPE_SECRET_KEY, priorSender = process.env.RESEND_API_KEY;
const owner = "move-owner@example.test", buyer = "move-buyer@example.test";
const session = "cs_test_movenotice0000000001";
type Notice = { to: string | string[]; text: string; attachments?: { content: string }[] };
const notices: Notice[] = [];
let store: Store, product: CallListing, start: number, next: number;
let mode: "known" | "partial" | "throw";
beforeEach(async () => {
  redis.clear(); notices.length = 0; mode = "known";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_cancel_only";
  process.env.RESEND_API_KEY = "re_test_call_cancel_only";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "api.resend.com" && method === "POST") {
      notices.push(JSON.parse(String(init?.body)) as Notice);
      return new Response(JSON.stringify({ id: `synthetic-notice-${notices.length}` }));
    }
    if (url.hostname === "api.stripe.com" && method === "GET" && url.pathname === "/v1/checkout/sessions") {
      return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
    }
    throw Error("No real provider or unexpected transport allowed");
  }) as typeof fetch;
  await claimHandle(owner, "movenotice", "Synthetic call studio", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestBela00001", true);
  await setSubscription(owner, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "In-person call", "", "80", null);
  assert.ok(made.ok);
  const setup = { kind: "weekly", minutes: 60, tz: "UTC", weekly: Array.from({ length: 7 }, () => [[540, 1020]]), noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: "", place: { lines: ["Synthetic meeting place"] }, video: false, meet: null, sessions: [] } as unknown as CallSetup;
  assert.ok((await setProductCall(owner, made.product.id, setup)).ok);
  store = (await storeForEmail(owner))!;
  product = (await readListing(store, made.product.id))! as CallListing;
  start = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3 * 86_400_000 + 10 * 3_600_000;
  next = start + 3_600_000;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 2 && commands.every(c => c[0] === "GET" && String(c[1]).startsWith("nl:meet:r:"))) {
      if (mode === "partial") return [];
      if (mode === "throw") throw Error("Synthetic unknown meeting sequence");
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
});
afterEach(() => {
  redis.pipeline = pipeline; globalThis.fetch = priorFetch;
  if (priorStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorStripe;
  if (priorSender === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = priorSender;
});

async function move() {
  const result = await moveBooking({ store, product, session, booked: { start, end: start + 3_600_000, email: buyer, buyerTz: "UTC" }, start: next, origin: "https://example.test" });
  assert.deepEqual(result, { ok: true, start: next, end: next + 3_600_000, moves: 1 });
  const raw = redis.run(["GET", movedKey(session)]);
  assert.equal(typeof raw, "string");
  assert.deepEqual(JSON.parse(raw as string), { s: next, e: next + 3_600_000, n: 1 }, "the move is already committed before the notification");
}

test("confirmed zero updates still sends both notices and the real sequence-one calendar", async () => {
  await move();
  assert.deepEqual(notices.flatMap(n => n.to).sort(), [buyer, owner].sort());
  assert.ok(notices.every(n => n.attachments?.length === 1));
  assert.ok(notices.every(n => Buffer.from(n.attachments![0].content, "base64").toString().includes("SEQUENCE:1")));
});

for (const failure of ["partial", "throw"] as const) {
  test(`unknown sequence cannot silently suppress the persisted move's text notices: ${failure}`, async () => {
    mode = failure;
    await move();
    assert.deepEqual(notices.flatMap(n => n.to).sort(), [buyer, owner].sort());
    assert.ok(notices.every(n => !n.attachments?.length), "no guessed calendar sequence");
    assert.ok(notices.every(n => !/calendar file attached/i.test(n.text)));
    assert.ok(!notices.find(n => [n.to].flat().includes(buyer))!.text.includes(bookingWords(store.language).newTimeAttached));
    assert.ok(notices.every(n => n.text.includes("11:00")), "the committed new time is still told");
  });
}
