/**
 * #5125 (1), call-packages: the person's data copy reads only their own call packages, found through their own paid
 * checkouts on the creator's Stripe account (lib/person-copy-stripe.ts), never the store's whole set of packages
 * (packagesKey), which never shrinks and holds every buyer's. One GET a package checkout of theirs, at most
 * CALL_PACKAGE_COPY_READS_MAX. Nothing the person sees is cut: their packages are copied as before, a package whose
 * record cannot be read still fails the copy, and the record's own buyer still decides whose it is.
 *
 * Synthetic only: the in-memory Redis stub and a stand-in for Stripe; nothing real is reached.
 */
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { packagesKey } from "@/lib/call-packages";
import { erasureScope } from "@/lib/person-erasure";
import * as personCopy from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_packages_only";
const OWNER = "pkgbound-owner@example.com";
const PERSON = "pkgbound-person@example.com";
const OTHER = "pkgbound-other@example.com";
const checkoutId = (n: number) => "cs_test_" + String(n).padStart(24, "0");
const THEIRS = checkoutId(1);
const NOT_A_PACKAGE = checkoutId(2);
const OTHERS = Array.from({ length: 60 }, (_, i) => checkoutId(1000 + i));
const token = (n: number) => n.toString(16).padStart(48, "0");

let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/checkout/sessions") return answer({ object: "list", data: url.searchParams.get("customer_details[email]") === PERSON ? sessions : [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, handle: string, kind?: string) => ({ id, status: "complete", payment_status: "paid", payment_intent: "pi_" + id.slice(-6), metadata: { store: handle, product: "call000001", ...(kind ? { kind } : {}) } });

/** Every command the copier sends, and its result. */
async function watched(run: () => Promise<unknown[]>): Promise<{ commands: unknown[][]; records: unknown[] | null; error: unknown }> {
  const real = redis.pipeline.bind(redis);
  const commands: unknown[][] = [];
  redis.pipeline = async (batch) => {
    for (const command of batch) commands.push(command as unknown[]);
    return real(batch);
  };
  try {
    return { commands, records: await run(), error: null };
  } catch (error) {
    return { commands, records: null, error };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pkgboundshop", "Package Bound Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Pkgb00001", subscriptionId: "sub_Pkgb00001", active: true, period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestPkgBound", true);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const record = (e: string, n: number) => JSON.stringify({ s: statsId, h: store.handle, p: "call000001", e, total: 4, at: 1_790_000_000, until: 0, token: token(n), holds: [] });
  // The store sold 60 packages to somebody else and one to the person; all of them are in the store's set.
  redis.run(["SADD", packagesKey(statsId), THEIRS, ...OTHERS]);
  redis.run(["SET", `nl:pkg:${THEIRS}`, record(PERSON, 1)]);
  OTHERS.forEach((id, i) => redis.run(["SET", `nl:pkg:${id}`, record(OTHER, 100 + i)]));
  sessions = [paid(THEIRS, store.handle, "package"), paid(NOT_A_PACKAGE, store.handle)];
  const scope = (await erasureScope(store, PERSON))!;
  const copier = personCopy.COPIERS["lib/call-packages.ts"];

  part("Only the person's own packages are read");
  const first = await watched(() => copier(scope));
  is("their package is copied, as before", (first.records as { product: string; sessions: number }[] | null)?.map((c) => [c.product, c.sessions]), [["call000001", 4]]);
  is("RED: the store's whole set of packages is not read", first.commands.some((c) => c[1] === packagesKey(statsId)), false);
  is("RED: one GET, their package's record, and nothing of the 60 other buyers", first.commands, [["GET", `nl:pkg:${THEIRS}`]]);
  is("RED: the bound is exported and is the most checkouts a copy lists", (personCopy as Record<string, unknown>).CALL_PACKAGE_COPY_READS_MAX, 200);

  part("The record still decides whose a package is");
  redis.run(["SET", `nl:pkg:${THEIRS}`, record(OTHER, 1)]);
  is("a checkout of theirs whose record names another buyer: nothing copied", (await watched(() => copier(scope))).records, []);
  redis.run(["DEL", `nl:pkg:${THEIRS}`]);
  is("a package whose record ran out: none, confirmed", (await watched(() => copier(scope))).records, []);
  redis.run(["SET", `nl:pkg:${THEIRS}`, record(PERSON, 1)]);

  part("A package that cannot be read fails the copy, never an empty part");
  const real = redis.pipeline.bind(redis);
  for (const [label, reply] of [
    ["a missing reply", []],
    ["a number for the record", [42]],
    ["a record that is not JSON", ["{nope"]],
    ["a record that is JSON but not an object", ['"7"']],
    ["a record that is a list", ["[1,2]"]],
    ["a record with no buyer", [JSON.stringify({ p: "call000001", total: 3, at: 1, until: 0, holds: [] })]],
    ["a record whose buyer is not text", [JSON.stringify({ p: "call000001", e: 7, total: 3, at: 1, until: 0, holds: [] })]],
  ] as [string, unknown[]][]) {
    redis.pipeline = async (batch) => (batch.length === 1 && (batch[0] as unknown[])[0] === "GET" && (batch[0] as unknown[])[1] === `nl:pkg:${THEIRS}` ? (reply as never) : real(batch));
    const run = await watched(() => copier(scope));
    redis.pipeline = real;
    is(`${label}: the copy fails`, run.error instanceof UnknownReplyError, true);
  }

  part("At the most checkouts a copy lists, the reads stay inside the bound");
  const many = Array.from({ length: 100 }, (_, i) => checkoutId(5000 + i));
  many.forEach((id, i) => redis.run(["SET", `nl:pkg:${id}`, record(PERSON, 5000 + i)]));
  sessions = many.map((id) => paid(id, store.handle, "package"));
  const fresh = (await erasureScope(store, PERSON))!;
  const full = await watched(() => copier(fresh));
  is("a hundred packages of theirs, all copied", full.records?.length, 100);
  is("one GET each, within CALL_PACKAGE_COPY_READS_MAX", [full.commands.length, full.commands.length <= Number((personCopy as Record<string, unknown>).CALL_PACKAGE_COPY_READS_MAX)], [100, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
