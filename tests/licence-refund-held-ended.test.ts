/**
 * The license keys' refund job and a refund that does not go through (Claude 5's pre-review of
 * claude5/licence-refunds-combined; its proofs, made RED here). Synthetic only: the in-memory Redis double and a
 * stand-in for the creator's Stripe account; the real revokeRefunded, keyForSale and checkKey.
 *
 * What fails here:
 *   - HIGH 1: a refund kept for a later look (lib/held-refunds.ts) read back as a full refund still pending marks the
 *     keyless sale PENDING_REFUND_SALE; when Stripe then answers it failed or canceled, the kept set let it go without
 *     handing it to the job, so the mark was never cleared and the paid sale never got its key;
 *   - HIGH 2 (in main and #2868 too): a full refund still pending revoked a key already given and was read at once, so
 *     when it then failed the paid sale's key stayed revoked for good. A pending refund now takes nothing back: the key
 *     stays valid, the refund stays unread, and the key is revoked only once Stripe says it went through;
 *   - kept refunds read back and held (still pending) keeping their turn, so HELD_REFUND_READS of them took every read
 *     of every run and one that went through behind them was never read (rule 30, the same flow);
 *   - LOW: an anchor in an unknown shape read as none and written again thirty days back (rule 24);
 *   - LOW: lost disputes whose sale stays unknown taking every lookup of the run from the refunds of the window;
 *   - #2868's HIGH at 9fa5c95602 (5bb167d833) on the kept path: a kept refund read back succeeded as only part of a
 *     charge read refunded in full, while the rest of that charge is still pending, revoked a key given (or wrote the
 *     final mark on a keyless sale) before the rest went through; when the rest then failed, a sale mostly paid kept
 *     its key revoked. The merge of #2868 checked the charge's refunds only in its own loop, which this branch's pass
 *     replaced, so neither the rows of the pages nor the kept ones read back were checked.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { PENDING_REFUND_SALE, checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { HELD_REFUND_READS } from "@/lib/held-refunds";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_held_ended";
const OWNER = "licenceheldended@example.com";
const ACCOUNT = "acct_1TestLicEnded1";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const sessionsByPayment: Record<string, Row[]> = {};
/** Payments whose checkout lookup answers in a shape the job cannot read (their sale stays unknown). */
const unreadablePayments = new Set<string>();
/** Refunds listed by GET /refunds (within its created[gte] window), and every refund GET /refunds/{id} answers. */
let listed: Row[] = [];
const byId = new Map<string, Row>();
/** Stripe's charge.dispute.closed events, newest first. */
let events: Row[] = [];
/** The charges whose own refunds were read (GET /refunds?charge=). */
const chargeReads: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[], more = false) => answer({ object: "list", data, has_more: more });
  const path = url.pathname.replace(/^\/v1/, "");
  const one = path.match(/^\/refunds\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = byId.get(one[1]);
    return found ? answer(found) : answer({ error: { message: "No such refund" } }, 404);
  }
  if (path === "/refunds" && url.searchParams.has("charge")) {
    // A charge's own refunds, as they stand now (a kept one as GET /refunds/{id} answers it), the charge as its id.
    const charge = url.searchParams.get("charge") ?? "";
    const now = new Map<string, Row>();
    for (const row of [...listed, ...byId.values()]) now.set(String(row.id), row);
    const rows = [...now.values()].filter((row) => (row.charge as { id?: string } | null)?.id === charge).map((row) => ({ ...row, charge }));
    chargeReads.push(charge);
    return list(rows);
  }
  if (path === "/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const after = url.searchParams.get("starting_after");
    const all = listed.filter((r) => Number(r.created) >= gte).sort((a, b) => Number(b.created) - Number(a.created));
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    return list(all.slice(from, from + 100), from + 100 < all.length);
  }
  if (path === "/events") {
    if (url.searchParams.get("type") !== "charge.dispute.closed") return list([]);
    const after = url.searchParams.get("starting_after");
    const from = after ? events.findIndex((e) => e.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return list(events.slice(from, from + limit), from + limit < events.length);
  }
  if (path === "/checkout/sessions") {
    const intent = url.searchParams.get("payment_intent") ?? "";
    if (unreadablePayments.has(intent)) return answer({ object: "list", data: "not a list", has_more: false });
    return list(sessionsByPayment[intent] ?? []);
  }
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  return list([]);
}) as typeof fetch;

type Status = "requires_action" | "pending" | "succeeded" | "failed" | "canceled";
/** A refund as Stripe gives it, its charge expanded: `full` when the charge is refunded in full. */
// Regra 23: the row now carries its own amount, as every refund Stripe sends does: each refund here is one of the whole
// charge, so it is whole on its own and needs no read of the charge's refunds (#2868's 5bb167d833, merged here).
const refundRow = (id: string, pi: string, created: number, status: Status, full: boolean): Row => ({
  id,
  object: "refund",
  amount: 2900,
  created,
  status,
  payment_intent: pi,
  charge: { id: `ch_${id.slice(3)}`, object: "charge", amount: 2900, amount_refunded: full ? 2900 : 0, refunded: full },
});

let store: Store;
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 30_000);
  } catch (error) {
    console.error(error);
    return "threw";
  }
};
const heldKey = () => `nl:keys:${store.statsId}:refunds:held`;
const anchorKey = () => `nl:keys:${store.statsId}:refunds:since`;
const seenOf = async (id: string) => (await redis.pipeline([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const keptIds = async () => ((await redis.pipeline([["ZRANGEBYSCORE", heldKey(), "-inf", "+inf"]]))[0] as string[]).map((m) => m.split("|")[0]).sort();
const anchorOf = async () => (await redis.pipeline([["GET", anchorKey()]]))[0];
const placeOf = async (product: Listing, reference: string) => (await redis.pipeline([["HGET", `nl:keys:${store.statsId}:${product.id}:sale`, reference]]))[0];
/** Makes every kept refund due now, as if its next look had come. */
const due = async () => {
  const members = (await redis.pipeline([["ZRANGEBYSCORE", heldKey(), "-inf", "+inf"]]))[0] as string[];
  if (members.length) await redis.pipeline([["ZADD", heldKey(), ...members.flatMap((m) => [NOW - 1, m])]]);
};
/** A store's refund job starting afresh: no anchor, no pass, nothing kept, nothing read. */
const fresh = async () => {
  await redis.pipeline([
    ["DEL", anchorKey()],
    ["DEL", `nl:keys:${store.statsId}:refunds:pass`],
    ["DEL", heldKey()],
  ]);
  listed = [];
  events = [];
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licheldended", "Lic Held Ended", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicHeldEnded01", subscriptionId: "sub_LicHeldEnded01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  /** A paid checkout of this store, its payment and a refund id. */
  const sale = (n: string) => {
    const reference = `cs_test_licheldend00${n}`;
    const pi = `pi_LicHeldEnded0${n}`;
    sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: "licheldended", product: app.id } }];
    return { reference, pi, id: `re_LicHeldEnded0${n}` };
  };
  /** Keeps a refund for a later look (read once as requires_action), then moves the anchor past it. */
  const keepThenPass = async (refunds: { id: string; pi: string; created: number }[]) => {
    listed = refunds.map((r) => refundRow(r.id, r.pi, r.created, "requires_action", false));
    for (const row of listed) byId.set(String(row.id), row);
    await run();
    listed = [refundRow("re_LicEndedLater0001", "pi_LicEndedLater0001", NOW - 60, "failed", false)];
    await run();
  };

  for (const ending of ["failed", "canceled"] as const) {
    part(`HIGH 1: a kept refund read back pending marks the keyless sale; Stripe then answers it ${ending}: the mark is cleared`);
    await fresh();
    const c = sale(ending === "failed" ? "31" : "32");
    const created = NOW - 3_600;
    await keepThenPass([{ ...c, created }]);
    is("kept, and the anchor moved past it (set-up)", [await keptIds(), Number(await anchorOf()) > created + 300], [[c.id], true]);
    byId.set(c.id, refundRow(c.id, c.pi, created, "pending", true));
    await due();
    await run();
    is("pending: the keyless sale holds the pending mark, the refund kept and unread (set-up)", [await placeOf(app, c.reference), await keptIds(), await seenOf(c.id)], [PENDING_REFUND_SALE, [c.id], 0]);
    byId.set(c.id, refundRow(c.id, c.pi, created, ending, false));
    await due();
    is(`${ending}: the run handles it`, await run(), 0);
    is(`${ending}: the pending mark is cleared, the refund read and let go`, [await placeOf(app, c.reference), await seenOf(c.id), await keptIds()], [null, 1, []]);
    const given = (await keyForSale(store, app, c.reference, "buyer@example.com")) as { state?: string } | null;
    is(`${ending}: the paid sale gets its key`, given?.state, "issued");
  }

  part("HIGH 2: a full refund still pending leaves a key already given valid; when it fails the key stays valid");
  await fresh();
  const d = sale("33");
  const dKey = ((await keyForSale(store, app, d.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  listed = [refundRow(d.id, d.pi, NOW - 5, "pending", true)];
  // Regra 23: the proof's set-up asserted [1, "revoked", 1] here (the old policy, revoked and read at once); the
  // policy is now that a pending refund takes nothing back yet.
  is("pending: nothing revoked, the key valid, the refund unread", [await run(), await checkKey(store, app, dKey), await seenOf(d.id)], [0, "valid", 0]);
  is("and read again next run, still pending: still valid and unread", [await run(), await checkKey(store, app, dKey), await seenOf(d.id)], [0, "valid", 0]);
  listed = [refundRow(d.id, d.pi, NOW - 5, "failed", false)];
  is("failed: read, the key of the paid sale still valid", [await run(), await checkKey(store, app, dKey), await seenOf(d.id)], [0, "valid", 1]);

  part("HIGH 2: a full refund still pending that then goes through revokes the key");
  await fresh();
  const e = sale("34");
  const eKey = ((await keyForSale(store, app, e.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  listed = [refundRow(e.id, e.pi, NOW - 5, "pending", true)];
  is("pending: the key valid", [await run(), await checkKey(store, app, eKey)], [0, "valid"]);
  listed = [refundRow(e.id, e.pi, NOW - 5, "succeeded", true)];
  is("succeeded: revoked and read", [await run(), await checkKey(store, app, eKey), await seenOf(e.id)], [1, "revoked", 1]);

  part("HIGH 2, a kept refund: read back pending on a sale with a key, the key stays valid until it goes through");
  await fresh();
  const f = sale("35");
  const fKey = ((await keyForSale(store, app, f.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  const fCreated = NOW - 7_200;
  await keepThenPass([{ ...f, created: fCreated }]);
  byId.set(f.id, refundRow(f.id, f.pi, fCreated, "pending", true));
  await due();
  is("pending: the key valid, the refund kept and unread", [await run(), await checkKey(store, app, fKey), await keptIds(), await seenOf(f.id)], [0, "valid", [f.id], 0]);
  byId.set(f.id, refundRow(f.id, f.pi, fCreated, "succeeded", true));
  await due();
  is("succeeded: revoked, read and let go", [await run(), await checkKey(store, app, fKey), await seenOf(f.id), await keptIds()], [1, "revoked", 1, []]);

  part("Rule 30: kept refunds still pending never take every read from one that went through behind them");
  await fresh();
  const blockers = Array.from({ length: HELD_REFUND_READS }, (_, i) => sale(`4${i}`));
  // Its id sorts after the blockers', so with the same score it is read after them.
  const late = { ...sale("49"), id: "re_LicHeldEndedZ049" };
  const gCreated = NOW - 9_000;
  await keepThenPass([...blockers, late].map((r) => ({ ...r, created: gCreated })));
  is("all kept (set-up)", (await keptIds()).length, HELD_REFUND_READS + 1);
  for (const b of blockers) byId.set(b.id, refundRow(b.id, b.pi, gCreated, "pending", true));
  byId.set(late.id, refundRow(late.id, late.pi, gCreated, "succeeded", true));
  await due();
  await run();
  is("the first run reads the blockers: each keyless sale holds the pending mark", await Promise.all(blockers.map((b) => placeOf(app, b.reference))), blockers.map(() => PENDING_REFUND_SALE));
  await run();
  is("the next run reads the one behind them: its sale is marked refunded, the refund read and let go", [await seenOf(late.id), (await keptIds()).includes(late.id)], [1, false]);

  part("LOW (rule 24): an anchor in an unknown shape is never read as none, nor written again");
  await fresh();
  await redis.pipeline([["SET", anchorKey(), "not-a-time"]]);
  const h = sale("51");
  const hKey = ((await keyForSale(store, app, h.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  listed = [refundRow(h.id, h.pi, NOW - 5, "succeeded", true)];
  is("the run stops before reading anything", [await run(), await checkKey(store, app, hKey)], ["threw", "valid"]);
  is("and leaves the anchor as it was", await anchorOf(), "not-a-time");
  await redis.pipeline([["DEL", anchorKey()]]);
  is("no anchor is a first pass: the refund is read", [await run(), await checkKey(store, app, hKey)], [1, "revoked"]);

  part("LOW: lost disputes whose sale stays unknown never take every lookup from the refunds of the window");
  await fresh();
  const lostCount = 25;
  events = Array.from({ length: lostCount }, (_, i) => {
    const pi = `pi_LicEndedLost${String(i).padStart(4, "0")}`;
    unreadablePayments.add(pi);
    return {
      id: `evt_LicEndedLost${String(i).padStart(4, "0")}`,
      object: "event",
      type: "charge.dispute.closed",
      created: NOW - 100 - i,
      data: { object: { id: `du_LicEndedLost${String(i).padStart(4, "0")}`, object: "dispute", status: "lost", charge: `ch_LicEndedLost${String(i).padStart(4, "0")}`, payment_intent: pi } },
    };
  });
  const k = sale("52");
  const kKey = ((await keyForSale(store, app, k.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  listed = [refundRow(k.id, k.pi, NOW - 50, "succeeded", true)];
  is("the refund of the window is handled in the same run", [await run(), await checkKey(store, app, kKey), await seenOf(k.id)], [1, "revoked", 1]);

  part("#2868's HIGH on the kept path: a kept refund read back succeeded as part of a charge whose rest is pending takes nothing back");
  // A $29 sale: $10 kept while it needed action, then succeeded; the other $19 made later, in the window, pending.
  // Stripe counts a pending refund in the charge's amount_refunded, so the kept $10 reads back as refunded in full.
  await fresh();
  const partRow = (id: string, pi: string, created: number, status: Status, amount: number, charge: string, back: number): Row => ({
    id,
    object: "refund",
    amount,
    created,
    status,
    payment_intent: pi,
    charge: { id: charge, object: "charge", amount: 2900, amount_refunded: back, refunded: back >= 2900 },
  });
  // p: a key given, the $19 fails. q: no key yet, the $19 fails. r: a key given, the $19 goes through.
  const [p, q, r] = [sale("36"), sale("37"), sale("38")];
  const pKey = ((await keyForSale(store, app, p.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  const rKey = ((await keyForSale(store, app, r.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  const tenCreated = NOW - 7_200;
  await keepThenPass([p, q, r].map((s) => ({ ...s, created: tenCreated })));
  is("the three $10 refunds kept, the anchor moved past them (set-up)", [(await keptIds()).length, Number(await anchorOf()) > tenCreated + 300], [3, true]);
  const chargeOf = (s: { id: string }) => `ch_${s.id.slice(3)}`;
  const nineteen = (s: { id: string; pi: string }, status: Status, back: number) => partRow(`${s.id}N`, s.pi, NOW - 5, status, 1900, chargeOf(s), back);
  for (const s of [p, q, r]) byId.set(s.id, partRow(s.id, s.pi, tenCreated, "succeeded", 1000, chargeOf(s), 2900));
  listed = [p, q, r].map((s) => nineteen(s, "pending", 2900));
  await due();
  chargeReads.length = 0;
  is(
    "the $10 read back with the $19 pending: nothing revoked, both keys valid, the $10 refunds kept and unread",
    [await run(), await checkKey(store, app, pKey), await checkKey(store, app, rKey), await keptIds(), await seenOf(p.id), await seenOf(r.id)],
    [0, "valid", "valid", [p.id, q.id, r.id].sort(), 0, 0],
  );
  is("the keyless sale holds the pending mark, never the final one", await placeOf(app, q.reference), PENDING_REFUND_SALE);
  is("each kept $10 read its charge's refunds once", [...new Set(chargeReads)].sort(), [p, q, r].map(chargeOf).sort());
  // The $19 of p and q fail (the charges read $10 back now); r's goes through.
  for (const s of [p, q]) byId.set(s.id, partRow(s.id, s.pi, tenCreated, "succeeded", 1000, chargeOf(s), 1000));
  listed = [nineteen(p, "failed", 1000), nineteen(q, "failed", 1000), nineteen(r, "succeeded", 2900)];
  await due();
  await run();
  is("p: the $19 fails: the key of a sale mostly paid stays valid", await checkKey(store, app, pKey), "valid");
  is("q: the $19 fails: the pending mark is cleared, and the paid sale gets its key", ((await keyForSale(store, app, q.reference, "buyer@example.com")) as { state?: string } | null)?.state, "issued");
  is("r: the $19 goes through: the key is revoked, the $10 read and let go", [await checkKey(store, app, rKey), await seenOf(r.id), await keptIds()], ["revoked", 1, []]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
