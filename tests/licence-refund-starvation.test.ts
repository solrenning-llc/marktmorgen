/**
 * #5285 row #2868 (Codex X6's LOW 2 on #2868 @96f5d99f6e, NOT FIXED): the license keys' refund job (lib/licence-keys.ts,
 * revokeRefunded) read the newest REFUND_PAGES pages of refunds every run and moved its place only once it had read them
 * all, sure. With more than REFUND_PAGES x 100 refunds after its place, it read the same newest pages on every run and
 * never reached the older ones, and one refund left unresolved held the place for good: a full refund never read kept
 * its key valid. Now, as lib/gifts.ts does, a pass goes on from where the last run stopped, and a refund Stripe finished
 * whose key could not be revoked for sure goes on a list to try again, so the place moves on; a refund still on its way
 * holds the place at its time, as before (the owner's decision 18 of 9 November 2026), and a full list holds it too.
 * Synthetic only: the in-memory Redis double and a stand-in for the creator's Stripe account; the real revokeRefunded,
 * keyForSale and checkKey.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_refund_starvation";
const OWNER = "licencestarve@example.com";
const HANDLE = "licencestarve";
const ACCOUNT = "acct_1TestLicStarve";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
/** Every refund on the account, any order: listed newest first, as Stripe does. */
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[], more = false) => answer({ object: "list", data, has_more: more });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/refunds" && !url.searchParams.has("charge")) {
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const sorted = refunds.filter((row) => (row.created as number) >= since).sort((a, b) => (b.created as number) - (a.created as number) || String(b.id).localeCompare(String(a.id)));
    const from = url.searchParams.get("starting_after");
    const start = from ? sorted.findIndex((row) => row.id === from) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return list(sorted.slice(start, start + limit), start + limit < sorted.length);
  }
  const one = /^\/refunds\/([A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const row = refunds.find((candidate) => candidate.id === one[1]);
    return row ? answer(row) : answer({ error: { message: "No such refund" } }, 404);
  }
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  return list([]);
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** A reply in an unknown shape for the HGET of one sale's key, while set: the job cannot tell its key for sure. */
let garbledReference = "";
redis.pipeline = (async (commands: Command[]) => {
  const replies = await memory(commands);
  if (!garbledReference) return replies;
  return replies.map((reply, i) => (commands[i][0] === "HGET" && String(commands[i][1]).endsWith(":sale") && commands[i][2] === garbledReference ? 7 : reply));
}) as typeof redis.pipeline;

type Status = "pending" | "succeeded";
/** A refund of a whole charge, its payment named. */
const refundRow = (id: string, pi: string | null, created: number, status: Status = "succeeded") => ({
  id, object: "refund", amount: 2900, created, status, payment_intent: pi,
  charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true },
});
/** Refunds of payments made elsewhere (no payment to look up): read and passed over without a lookup. */
const others = (count: number, newest: number) => Array.from({ length: count }, (_, i) => refundRow(`re_Other${String(i).padStart(5, "0")}`, null, newest - i));

let store: Store;
let app: Listing;
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const place = async () => (await memory([["GET", `nl:keys:${store.statsId}:refunds:since`]]))[0];
const retried = async () => (await memory([["HGETALL", `nl:keys:${store.statsId}:refunds:retry`]]))[0] as string[];

async function fresh(): Promise<void> {
  redis.clear();
  refunds = [];
  await claimHandle(OWNER, HANDLE, "Licence Starve", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicenceStarve1", subscriptionId: "sub_LicenceStarve1", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  app = (await readListing(store, made.product.id))!;
  // The place, a while back: the store's refund job ran before.
  await memory([["SET", `nl:keys:${store.statsId}:refunds:since`, String(NOW - 20_000)]]);
}
async function sale(reference: string, pi: string): Promise<string> {
  const given = await keyForSale(store, app, reference, "buyer@example.com");
  if (given?.state !== "issued") throw new Error("no key");
  sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: HANDLE, product: app.id } }];
  return given.key;
}

async function main(): Promise<void> {
  part("(a) More refunds after the place than a run reads: the older full refund is still reached, and its key revoked");
  await fresh();
  const old = await sale("cs_test_starve000000001", "pi_StarveOld00001");
  refunds = [refundRow("re_StarveOld00001", "pi_StarveOld00001", NOW - 10_000), ...others(350, NOW - 100)];
  for (let i = 0; i < 6 && (await checkKey(store, app, old)) === "valid"; i += 1) await run();
  is("within six runs its key is revoked", await checkKey(store, app, old), "revoked");

  part("(b) A refund Stripe finished whose key could not be told goes on the list to try again; the place moves on");
  await fresh();
  const stuck = await sale("cs_test_starve000000002", "pi_StarveStuck001");
  refunds = [refundRow("re_StarveStuck001", "pi_StarveStuck001", NOW - 5_000), ...others(20, NOW - 100)];
  garbledReference = "cs_test_starve000000002";
  await run();
  garbledReference = "";
  is("nothing revoked while its key could not be told", await checkKey(store, app, stuck), "valid");
  is("it is on the list to try again", await retried(), ["re_StarveStuck001", "pi_StarveStuck001"]);
  is("and the place moved past it", Number(await place()) > NOW - 5_000, true);
  await run();
  is("the next run reads it again from Stripe and revokes its key", await checkKey(store, app, stuck), "revoked");
  is("and lets it go from the list", await retried(), []);

  part("(c) A full refund still on its way holds the place at its time, and revokes nothing");
  await fresh();
  const waiting = await sale("cs_test_starve000000003", "pi_StarveWait0001");
  refunds = [refundRow("re_StarveWait0001", "pi_StarveWait0001", NOW - 4_000, "pending"), ...others(20, NOW - 100)];
  await run();
  await run();
  is("its key stays valid while the refund may still fail", await checkKey(store, app, waiting), "valid");
  is("the place waits at or before it", Number(await place()) <= NOW - 4_000, true);
  is("and it is never put on the list to try again", await retried(), []);

  part("(d) With the list full, a refund whose work could not be done holds the place");
  await fresh();
  const full = await sale("cs_test_starve000000004", "pi_StarveFull0001");
  const fill: string[] = [];
  for (let i = 0; i < 100; i += 1) fill.push(`re_Fill${String(i).padStart(5, "0")}`, `pi_Fill${String(i).padStart(9, "0")}`);
  await memory([["HSET", `nl:keys:${store.statsId}:refunds:retry`, ...fill]]);
  refunds = [refundRow("re_StarveFull0001", "pi_StarveFull0001", NOW - 3_000), ...others(20, NOW - 100)];
  garbledReference = "cs_test_starve000000004";
  await run();
  garbledReference = "";
  is("nothing revoked", await checkKey(store, app, full), "valid");
  is("it is not on the full list", (await retried()).includes("re_StarveFull0001"), false);
  is("the place waits at or before it", Number(await place()) <= NOW - 3_000, true);
  await run();
  is("the next run reads it again from the place and revokes its key", await checkKey(store, app, full), "revoked");
  done();
}

void main();
