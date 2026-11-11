/**
 * Claude 1 (6784985573) and Claude 6 (6786527134) on #2868: a full refund in `requires_action` gave rowGivesBack
 * false and was skipped without making the run unsure, so a newer refund moved the job's anchor past it; once it
 * succeeded it was never listed again, and the delivered key stayed valid for good. Now it is on its way, as a pending
 * one: a delivered key stays valid, a keyless sale gets the pending mark, the refund stays unread and the anchor stays,
 * so it is read again once it settles. Synthetic only: the in-memory Redis double and a Stripe stand-in that honors
 * created[gte].
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { REFUNDED_SALE, addKeys, checkKey, keyForSale, readKeyList, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_pending_mark";
const OWNER = "licencepending@example.com";
const ACCOUNT = "acct_1TestLicPend1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
let sessionsAnswer: "list" | "broken" = "list";
/** How the charge's own refunds (GET /refunds?charge=) are answered, and the charges asked about. */
let chargeRefundsAnswer: "list" | "broken" | "more" = "list";
const chargeReads: string[] = [];
/** The charge a refund row names, as an id or its expanded object. */
const chargeIdOf = (row: Record<string, unknown>) => (typeof row.charge === "string" ? row.charge : ((row.charge as { id?: string } | null)?.id ?? ""));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return sessionsAnswer === "broken" ? answer({ object: "list" }) : list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/refunds" && url.searchParams.has("charge")) {
    const charge = url.searchParams.get("charge") ?? "";
    chargeReads.push(charge);
    if (chargeRefundsAnswer === "broken") return answer({ object: "list" });
    // Stripe lists a charge's refunds with the charge as its id (not expanded on this read).
    const rows = refunds.filter((row) => chargeIdOf(row) === charge).map((row) => ({ ...row, charge }));
    return chargeRefundsAnswer === "more" ? answer({ object: "list", data: rows, has_more: true }) : list(rows);
  }
  // Honors created[gte], as Stripe does: a refund older than the job's anchor is never listed again.
  if (path === "/refunds") return list(refunds.filter((row) => Number(row.created) >= Number(url.searchParams.get("created[gte]") ?? 0)));
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  if (path === "/events") return list([]);
  return list([]);
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** The double with LPOP, which it does not implement: LINDEX 0 then LTRIM, one test process, nothing in between. */
const real = (async (commands: Command[]) => {
  if (!commands.some((command) => command[0] === "LPOP")) return memory(commands);
  const out: unknown[] = [];
  for (const command of commands) {
    if (command[0] !== "LPOP") {
      out.push((await memory([command]))[0]);
      continue;
    }
    const [head] = await memory([["LINDEX", command[1], 0]]);
    if (typeof head === "string") await memory([["LTRIM", command[1], 1, -1]]);
    out.push(typeof head === "string" ? head : null);
  }
  return out;
}) as typeof redis.pipeline;
redis.pipeline = real;

type Status = "pending" | "succeeded" | "failed" | "canceled" | "requires_action";
/** A refund row of GET /refunds as Stripe gives it: a full refund going through sets the charge refunded, a failed or canceled one sets it back. */
const refundRow = (id: string, pi: string, status: Status) => {
  const back = status === "pending" || status === "succeeded" || status === "requires_action";
  // Regra 23: the row now carries its own amount, as every refund Stripe sends does. A refund of the whole charge is
  // whole on its own; a row without it is unknown and now needs the charge's refunds read (review of #2868, HIGH).
  return { id, object: "refund", amount: 2900, created: NOW - 30, status, payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: back ? 2900 : 0, refunded: back } };
};
let store: Store;
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const seenOf = async (id: string) => (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const placeOf = async (product: Listing, reference: string) => (await real([["HGET", `nl:keys:${store.statsId}:${product.id}:sale`, reference]]))[0];
/** A mark the job leaves in a sale's place: text that is not a key (no key has a space). */
const isMark = (value: unknown) => typeof value === "string" && /\s/.test(value) && readKeyList(value).keys.length === 0;
/** The pending refund's own mark: a mark, not the final one. */
const isPendingMark = (value: unknown) => isMark(value) && value !== REFUNDED_SALE;
/** The compare-and-swap the job turns or clears a pending mark with. */
const isSwap = (command: Command) => String(command[0]).toUpperCase() === "EVAL" && String(command[1]).includes("license-sale-swap");

async function give(product: Listing, reference: string, email = "buyer@example.com"): Promise<unknown> {
  try {
    return await keyForSale(store, product, reference, email);
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licencepending", "Licence Pending", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicencePend001", subscriptionId: "sub_LicencePend001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  const pooled = await addProduct(OWNER, "Glaze Pack", "", "19", null);
  if (!pooled.ok) throw new Error("no pool product");
  await setProductLink(OWNER, pooled.product.id, "https://example.com/glaze");
  await setProductKeys(OWNER, pooled.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const pack = (await readListing(store, pooled.product.id))!;
  const waiting = `nl:keys:${store.statsId}:${pack.id}:waiting`;
  /** A paid checkout of this store for a product, with one refund of the given status; its key not given yet. */
  const sale = (n: string, product: Listing, status: Status) => {
    const reference = `cs_test_licpend0000${n}`;
    const pi = `pi_LicencePend00${n}`;
    const id = `re_LicencePend00${n}`;
    sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: "licencepending", product: product.id } }];
    refunds = [refundRow(id, pi, status)];
    return { reference, pi, id, set: (next: Status) => (refunds = [refundRow(id, pi, next)]) };
  };

  part("A full refund in requires_action, then a newer refund handled: once it succeeds, its key is revoked");
  const a = (await give(app, "cs_test_licpend000031")) as { key?: string };
  const b = (await give(app, "cs_test_licpend000032")) as { key?: string };
  const saleA = sale("31", app, "requires_action");
  const rowA = refunds[0];
  rowA.created = NOW - 5_000;
  sale("32", app, "succeeded");
  const rowB = refunds[0];
  refunds = [rowB, rowA];
  is("run 1: B revoked, A still valid while its refund needs an action", [await run(), await checkKey(store, app, a.key ?? ""), await checkKey(store, app, b.key ?? "")], [1, "valid", "revoked"]);
  is("A's refund stays unread", await seenOf(saleA.id), 0);
  rowA.status = "succeeded";
  is("run 2, A's refund succeeded: A revoked and its refund read", [await run(), await checkKey(store, app, a.key ?? ""), await seenOf(saleA.id)], [1, "revoked", 1]);

  part("A keyless sale whose full refund needs an action gets no key, and gets it once the refund fails");
  const c = sale("33", app, "requires_action");
  refunds[0].created = NOW - 20;
  is("run: nothing revoked, the refund unread, a pending mark in the sale's place", [await run(), await seenOf(c.id), isPendingMark(await placeOf(app, c.reference))], [0, 0, true]);
  is("no key while it needs an action", await give(app, c.reference), null);
  c.set("failed");
  refunds[0].created = NOW - 20;
  is("failed: read, the mark cleared", [await run(), await seenOf(c.id), await placeOf(app, c.reference)], [0, 1, null]);
  is("and the paid sale gets its key", typeof ((await give(app, c.reference)) as { key?: string } | null)?.key, "string");

  done();
}

void main();
