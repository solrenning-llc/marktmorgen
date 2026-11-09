/**
 * The license keys' refund job with both of its ways of reading a refund again later, as combined in
 * claude5/licence-refunds-combined: the pass kept between runs (claude5/licence-refunds-progress, audit A3) with the
 * pending refund's own mark (PENDING_REFUND_SALE, #2868), and the refunds Stripe has not finished kept by id
 * (lib/held-refunds.ts, claude5/plan-refund-own-dispute; rule 30). Synthetic only: the in-memory Redis double and a
 * stand-in for the creator's Stripe account; the real revokeRefunded, keyForSale and checkKey.
 *
 * What fails here:
 *   - a refund that gives nothing back yet (its charge not refunded in full) passed over by the pass and never read
 *     again once it goes through, after the anchor moved past it;
 *   - a kept refund read back as a full refund still pending let go before it settles (its sale's pending mark would
 *     then never turn final nor be cleared), or kept after it was handled;
 *   - kept refunds read back taking the lookups the pass needs: a refund of the window is still handled in the same run.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { PENDING_REFUND_SALE, REFUNDED_SALE, checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { HELD_REFUND_READS } from "@/lib/held-refunds";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_held_pass";
const OWNER = "licenceheldpass@example.com";
const ACCOUNT = "acct_1TestLicHeldP1";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const sessionsByPayment: Record<string, Row[]> = {};
/** Refunds listed by GET /refunds (within its created[gte] window), and every refund GET /refunds/{id} answers. */
let listed: Row[] = [];
const byId = new Map<string, Row>();
let readBack = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[], more = false) => answer({ object: "list", data, has_more: more });
  const path = url.pathname.replace(/^\/v1/, "");
  const one = path.match(/^\/refunds\/([A-Za-z0-9_]+)$/);
  if (one) {
    readBack += 1;
    const found = byId.get(one[1]);
    return found ? answer(found) : answer({ error: { message: "No such refund" } }, 404);
  }
  if (path === "/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const after = url.searchParams.get("starting_after");
    const all = listed.filter((r) => Number(r.created) >= gte).sort((a, b) => Number(b.created) - Number(a.created));
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    return list(all.slice(from, from + 100), from + 100 < all.length);
  }
  if (path === "/checkout/sessions") return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  return list([]);
}) as typeof fetch;

type Status = "requires_action" | "pending" | "succeeded" | "failed";
/** A refund as Stripe gives it, its charge expanded: `full` when the charge is refunded in full. */
const refundRow = (id: string, pi: string, created: number, status: Status, full: boolean): Row => ({
  id,
  object: "refund",
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
const seenOf = async (id: string) => (await redis.pipeline([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const keptIds = async () => ((await redis.pipeline([["ZRANGEBYSCORE", heldKey(), "-inf", "+inf"]]))[0] as string[]).map((m) => m.split("|")[0]).sort();
const anchorOf = async () => Number((await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`]]))[0]);
const placeOf = async (product: Listing, reference: string) => (await redis.pipeline([["HGET", `nl:keys:${store.statsId}:${product.id}:sale`, reference]]))[0];
/** Makes every kept refund due now, as if its next look had come. */
const due = async () => {
  const members = (await redis.pipeline([["ZRANGEBYSCORE", heldKey(), "-inf", "+inf"]]))[0] as string[];
  if (members.length) await redis.pipeline([["ZADD", heldKey(), ...members.flatMap((m) => [NOW - 1, m])]]);
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licenceheldpass", "Licence Held Pass", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicenceHeldP01", subscriptionId: "sub_LicenceHeldP01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  /** A paid checkout of this store, its payment and a refund id. */
  const sale = (n: string) => {
    const reference = `cs_test_licheldp000${n}`;
    const pi = `pi_LicenceHeldP0${n}`;
    sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: "licenceheldpass", product: app.id } }];
    return { reference, pi, id: `re_LicenceHeldP0${n}` };
  };

  part("1. A refund that gives nothing back yet is kept by id; the anchor moves; once through, its key is revoked");
  const a = sale("01");
  const aKey = ((await keyForSale(store, app, a.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  const aCreated = NOW - 3_600;
  listed = [refundRow(a.id, a.pi, aCreated, "requires_action", false)];
  byId.set(a.id, listed[0]);
  is("the run revokes nothing, keeps the refund and leaves it unread", [await run(), await keptIds(), await seenOf(a.id), await checkKey(store, app, aKey)], [0, [a.id], 0, "valid"]);
  // Newer refunds that take nothing back move the anchor past the kept one at the end of the pass.
  listed = [refundRow("re_LicenceHeldPLater1", "pi_LicenceHeldPLater1", NOW - 60, "failed", false)];
  await run();
  is("the anchor moved past the kept refund", (await anchorOf()) > aCreated + 300, true);
  is("it is still kept", await keptIds(), [a.id]);
  // It goes through; GET /refunds no longer lists it (it is before the window), only GET /refunds/{id} answers it.
  byId.set(a.id, refundRow(a.id, a.pi, aCreated, "succeeded", true));
  await due();
  is("read back by its id: the key is revoked, the refund read and let go", [await run(), await checkKey(store, app, aKey), await seenOf(a.id), await keptIds()], [1, "revoked", 1, []]);
  is("a later run changes nothing", [await run(), await keptIds()], [0, []]);

  part("2. Kept, then read back as a full refund still pending: the sale's pending mark, and it stays kept until it settles");
  const b = sale("02");
  // Inside the window the anchor of part 1 left (it moved to the newest refund read there).
  const bCreated = NOW - 10;
  listed = [refundRow(b.id, b.pi, bCreated, "requires_action", false)];
  byId.set(b.id, listed[0]);
  await run();
  is("kept", await keptIds(), [b.id]);
  listed = [];
  byId.set(b.id, refundRow(b.id, b.pi, bCreated, "pending", true));
  await due();
  is("read back pending: the keyless sale gets the pending mark, the refund stays unread and kept", [await run(), await placeOf(app, b.reference), await seenOf(b.id), await keptIds()], [0, PENDING_REFUND_SALE, 0, [b.id]]);
  is("while pending, no key is given", await keyForSale(store, app, b.reference, "buyer@example.com"), null);
  byId.set(b.id, refundRow(b.id, b.pi, bCreated, "succeeded", true));
  await due();
  is("through: the mark turns final, the refund is read and let go", [await run(), await placeOf(app, b.reference), await seenOf(b.id), await keptIds()], [0, REFUNDED_SALE, 1, []]);

  part("3. Kept refunds read back never take the lookups the pass needs");
  // HELD_REFUND_READS kept refunds, each of a payment with no checkout and no plan (three lookups each), due now.
  const many: string[] = [];
  for (let i = 0; i < HELD_REFUND_READS; i += 1) {
    const id = `re_LicenceHeldPMany${i}`;
    many.push(id);
    byId.set(id, refundRow(id, `pi_LicenceHeldPMany${i}`, NOW - 7_200 - i, "succeeded", true));
  }
  await redis.pipeline([["ZADD", heldKey(), ...many.flatMap((id) => [NOW - 1, `${id}|${byId.get(id)!.created}`])]]);
  const c = sale("03");
  const cKey = ((await keyForSale(store, app, c.reference, "buyer@example.com")) as { key?: string } | null)?.key ?? "";
  listed = [refundRow(c.id, c.pi, NOW - 30, "succeeded", true)];
  readBack = 0;
  is("the window's full refund is handled in the same run", [await run(), await checkKey(store, app, cKey), await seenOf(c.id)], [1, "revoked", 1]);
  is(`every due kept refund was read back (${HELD_REFUND_READS})`, readBack, HELD_REFUND_READS);
  const left = (await keptIds()).length;
  is("some kept refunds were left for the next run, not let go unread", left > 0 && left < HELD_REFUND_READS, true);
  is("those left were not marked read", (await Promise.all(many.map(seenOf))).filter((s) => s === 1).length, HELD_REFUND_READS - left);
  await due();
  await run();
  is("the next run reads and lets go of the rest", [await keptIds(), (await Promise.all(many.map(seenOf))).every((s) => s === 1)], [[], true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
