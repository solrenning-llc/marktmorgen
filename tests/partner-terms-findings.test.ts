/**
 * 630 [HN6](39), the review of #1924 (Claude 1, cloud), on the port onto main: what the partner reads about who ends a
 * share, a share the store ends keeping what was already earned, the sale's own payment time, an answer whose outcome
 * is unknown, the PayPal address route under a busy record, re-saving the current term on its last day, and a bulk
 * decision that stops halfway keeping its undo. Synthetic store, synthetic sales, the in-memory Redis stand-in.
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { affiliateCookieName, changeIdentity, decideMany, noteSession, notePartners, proposePartnerShare, readAffiliate, undoMany } from "@/lib/affiliates";
import { offerWords } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { POST as answerRoute } from "@/app/api/store/affiliates/partner-answer/route";
import { POST as paytoRoute } from "@/app/api/store/affiliates/payto/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";
const DAY = 86400;
const SWAP = "-- marktmorgen:affiliate-swap:v1\n";

async function main(): Promise<void> {
  redis.clear();
  const owner = "termsfindings@example.com";
  const handle = "termsfindings";
  await claimHandle(owner, handle, "Terms Findings", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Findingsxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_findings", subscriptionId: "sub_findings", active: true, tier: "creator", period: paidPeriod() });
  const people = `nl:aff:${statsId}:people`;
  const person = (id: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null, ...extra });
  const put = async (one: ReturnType<typeof person>) => redis.pipeline([["HSET", people, one.id, JSON.stringify(one)]]);
  const store = async () => (await storeForEmail(owner))!;
  const read = async (id: string) => (await readAffiliate(await store(), id))!;
  const earned = async () => ((await redis.pipeline([["HGETALL", `nl:aff:${statsId}:shares`]]))[0] as string[]).filter((_, i) => i % 2 === 0);
  // Every swap of one record answered as the test says, the rest as Redis would.
  const real = redis.pipeline.bind(redis);
  const swapAnswer = (id: string, answer: unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const one = commands.length === 1 ? commands[0] : null;
      if (one && one[0] === "EVAL" && String(one[1]).startsWith(SWAP) && one[4] === id) return [answer];
      return real(commands);
    }) as typeof redis.pipeline;
  };
  const restore = () => {
    redis.pipeline = real;
  };

  part("1. Who ends a share until revoked, in every place the partner reads it");
  const offer = offerWords({ id: "a1b2c3d4e5f6", sid: "s", storeName: "Terms Findings", handle, share: { percent: 10, products: [A] }, titles: ["Book"], at: 0 });
  is("the offer in a studio says the store ends it, or they ask it to", offer.endsWith("It runs until the store ends it, or you ask it to."), true);
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("the studio never says the partner ends it themselves", /until you or they end it/i.test(studio), false);
  is("the studio says they can ask", studio.includes("it runs until you end it, or they ask you to"), true);

  part("2. A share the store ends keeps what was already earned, even noted late");
  const p = "aaaaaaaaaaaa";
  await put(person(p));
  const T = Math.floor(Date.now() / 1000);
  await proposePartnerShare(await store(), p, { percent: 20, products: [A] }, T - 10 * DAY);
  is("ended by the store", await proposePartnerShare(await store(), p, null, T - DAY), { ok: true, state: "applied" });
  const sale = (ref: string, at: number) => ({ ref, pi: `pi_${ref}`, at, product: A, title: "Book", base: 1000, total: 1000, currency: "usd", buyer: "buyer@example.com" });
  await notePartners(await store(), sale("cs_test_before_end", T - 2 * DAY));
  await notePartners(await store(), sale("cs_test_after_end", T - DAY + 60));
  is("a sale paid before the end, noted after it, still earns; one after it does not", await earned(), [`cs_test_before_end:${p}`]);

  part("3. The end is compared with when the buyer paid, not when the checkout opened");
  const q = "bbbbbbbbbbbb";
  await put(person(q));
  const end = T - DAY;
  await proposePartnerShare(await store(), q, { percent: 15, products: [A], until: end }, end - 30 * DAY);
  const session = (id: string, created: number, payment_intent: unknown) => ({
    id, mode: "payment", status: "complete", payment_status: "paid", created, amount_total: 1000, currency: "usd",
    total_details: { amount_tax: 0 }, payment_intent, metadata: { store: handle, product: A, title: "Book" }, customer_details: { email: "buyer@example.com" },
  });
  // Codex G on #1924 at dda73b793b: the payment's time is its settled charge's (payment_intent.latest_charge), never
  // the intent's creation nor the checkout's opening, which both come before the buyer pays.
  // The charge's settlement is its balance transaction's time (made when the charge succeeds, Codex T on #1924); the
  // charge object's own `created` comes first, for a payment that settles later.
  const charged = (id: string, intentCreated: number, settled: number, chargeCreated = intentCreated) => ({ id, created: intentCreated, latest_charge: { id: `ch_${id.slice(3)}`, object: "charge", status: "succeeded", paid: true, created: chargeCreated, balance_transaction: { id: `txn_${id.slice(3)}`, object: "balance_transaction", created: settled } } });
  // Opened two hours before the end, the intent made an hour before it, charged an hour after it: no share.
  await noteSession(await store(), session("cs_test_paid_after", end - 7200, charged("pi_paid_after", end - 3600, end + 3600)));
  // Opened and charged before the end.
  await noteSession(await store(), session("cs_test_paid_before", end - 7200, charged("pi_paid_before", end - 7000, end - 3600)));
  const forQ = (await earned()).filter((key) => key.endsWith(`:${q}`));
  is("only the sale charged before the end earns, whatever the intent's own time", forQ, [`cs_test_paid_before:${q}`]);
  // Without a settled charge's time, a checkout opened before the end may have been paid after it: not known, so the
  // sale is left for the next run (the sweep's failOrder), never credited on the checkout's time.
  const unknownAt = async (ref: string, payment_intent: unknown) => noteSession(await store(), session(ref, end - 60, payment_intent)).then(() => "noted", (error: Error) => error.name);
  is("the intent not expanded: unknown, nothing credited", await unknownAt("cs_test_unk_intent", "pi_not_expanded"), "UnknownReplyError");
  is("the charge not expanded: unknown", await unknownAt("cs_test_unk_charge", { id: "pi_charge_id", created: end - 120, latest_charge: "ch_only_id" }), "UnknownReplyError");
  is("a charge that did not succeed: unknown", await unknownAt("cs_test_unk_failed", { id: "pi_charge_failed", created: end - 120, latest_charge: { id: "ch_failed", status: "failed", paid: false, created: end - 30 } }), "UnknownReplyError");
  is("and nothing of them was credited", (await earned()).filter((key) => key.startsWith("cs_test_unk")).length, 0);
  // A checkout opened after the end was paid after it too: no share, and nothing to wait for.
  is("opened after the end, the intent not expanded: no share and no wait", await noteSession(await store(), session("cs_test_opened_after", end + 60, "pi_opened_after")).then(() => (async () => (await earned()).includes(`cs_test_opened_after:${q}`))(), (error: Error) => error.name), false);
  is("the sweep reads each checkout with its charge, so the time is there", readFileSync("lib/checkout-sweep.ts", "utf8").includes("expand[]=data.payment_intent.latest_charge"), true);
  // Codex T on #1924 at b41a2fb0f3: a payment that settles later (an asynchronous method) has its charge created before
  // the end and its balance transaction after it: no share.
  await noteSession(await store(), session("cs_test_async_after", end - 7200, charged("pi_async_after", end - 7000, end + 600, end - 6000)));
  is("a charge created before the end but settled after it earns nothing", (await earned()).includes(`cs_test_async_after:${q}`), false);
  is("a charge whose settlement time was not read: unknown", await unknownAt("cs_test_unk_txn", { id: "pi_txn_id", created: end - 120, latest_charge: { id: "ch_txn_id", object: "charge", status: "succeeded", paid: true, created: end - 100, balance_transaction: "txn_only_id" } }), "UnknownReplyError");
  // Codex G on #1924 at b41a2fb0f3: a checkout with no readable opening time is never taken as opened now, after the end.
  const noOpening = async (ref: string, created: unknown) => noteSession(await store(), { ...session(ref, 0, "pi_no_opening"), created } as never).then(() => "noted", (error: Error) => error.name);
  is("no opening time, the intent not expanded: unknown, never 'opened after the end'", [await noOpening("cs_test_no_created", undefined), await noOpening("cs_test_frac_created", end - 0.5), await noOpening("cs_test_zero_created", 0)], ["UnknownReplyError", "UnknownReplyError", "UnknownReplyError"]);
  is("and nothing of them was written", (await earned()).filter((key) => /cs_test_(no|frac|zero)_created/.test(key)).length, 0);
  is("the sweep reads each charge with its balance transaction, so the settlement time is there", readFileSync("lib/checkout-sweep.ts", "utf8").includes("expand[]=data.payment_intent.latest_charge.balance_transaction"), true);


  part("4. An answer whose write may have landed is never said to have changed nothing");
  const r = "cccccccccccc";
  await put(person(r));
  await proposePartnerShare(await store(), r, { percent: 10, products: [A], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), r, { percent: 5, products: [A], until: T + 60 * DAY }, T + 1);
  const token = randomBytes(32).toString("hex");
  await redis.pipeline([["SET", `nl:aff:session:${createHash("sha256").update(`nimbus-aff-session:${token}`).digest("hex").slice(0, 40)}`, JSON.stringify({ s: statsId, a: r })]]);
  const change = (await read(r)).terms!.change!;
  const answer = async (value: string) => {
    const form = new FormData();
    form.set("handle", handle);
    form.set("answer", value);
    form.set("change", changeIdentity(change));
    const response = await answerRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/partner-answer", { method: "POST", headers: { cookie: `${affiliateCookieName(handle)}=${token}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };
  swapAnswer(r, "QUEUED?");
  const unsure = await answer("yes");
  restore();
  is("the swap answered in an unknown shape: said unsure", unsure, `https://marktmorgen.com/@${handle}/affiliates?status=partner-unsure#partner`);
  swapAnswer(r, 0);
  const busy = await answer("yes");
  restore();
  is("the record kept moving under it: said busy, nothing written", [busy, (await read(r)).share?.percent], [`https://marktmorgen.com/@${handle}/affiliates?status=partner-busy#partner`, 10]);

  part("5. The PayPal address route under a busy or unknown record: a visible answer, never a 500");
  const payto = async () => {
    const form = new FormData();
    form.set("handle", handle);
    form.set("paypal", "newpay@example.com");
    return paytoRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/payto", { method: "POST", headers: { cookie: `${affiliateCookieName(handle)}=${token}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: form }));
  };
  swapAnswer(r, 0);
  const kept = await payto();
  restore();
  is("busy: 503 that says nothing changed", [kept.status, (await kept.text()).includes("Nothing was changed")], [503, true]);
  swapAnswer(r, "QUEUED?");
  const lost = await payto();
  restore();
  const lostText = await lost.text();
  is("unknown: 503 that does not claim nothing changed", [lost.status, lostText.includes("Nothing was changed"), lostText.includes("could not confirm")], [503, false, true]);

  part("6. The share in force can be saved again on its own last day");
  const s = "dddddddddddd";
  const tomorrow = (Math.floor(T / DAY) + 1) * DAY;
  const today = new Date(T * 1000).toISOString().slice(0, 10);
  await put(person(s, { share: { percent: 10, products: [A], until: tomorrow }, terms: { change: null, history: [{ at: T - DAY, by: "creator", kind: "started", percent: 10, products: 1, until: tomorrow }] } }));
  const sessionCookie = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${sessionCookie}` }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string; state?: string };
  };
  is("saving it as it is passes", await post({ action: "share", id: s, percent: 10, products: [A], ends: today }), { ok: true, state: "same" });
  // The same end with another percentage is still that end: it is accepted, and the change waits for their yes.
  is("the same end with another percentage waits for their yes", await post({ action: "share", id: s, percent: 20, products: [A], ends: today }), { ok: true, state: "waiting" });
  is("an end of today for a share that ends on another day is still refused", (await post({ action: "share", id: r, percent: 10, products: [A], ends: today })).error, "share_ends");

  part("7. A bulk decision that stops halfway keeps the undo of what it did");
  const ids = ["eeeeeeeeeee1", "eeeeeeeeeee2", "eeeeeeeeeee3"];
  for (const id of ids) await put(person(id, { status: "pending", decidedAt: 0 }));
  swapAnswer(ids[1], 0);
  const bulk = await decideMany(await store(), ids, "approve");
  restore();
  is("the two written are in the undo, the one not written is named", [bulk.before.map((b) => b.id), bulk.held.map((h) => `${h.id}:${h.why}`)], [[ids[0], ids[2]], [`${ids[1]}:unavailable`]]);
  is("and the undo puts both back", [(await undoMany(await store(), bulk.before, "approve")).undone, (await read(ids[0])).status, (await read(ids[2])).status], [2, "pending", "pending"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
