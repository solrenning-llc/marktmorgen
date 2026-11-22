/**
 * #5125 (1), call-packages: the person's data copy reads only their own call packages, never the store's whole set of
 * packages (packagesKey), which never shrinks and holds every buyer's. Since the Stripe-read copiers row (#5125, 22
 * November 2026) they are found through their own index (buyerPackagesKey), not their paid checkouts on the creator's
 * Stripe account: two SMEMBERS, then one GET a package of theirs, inside CALL_PACKAGE_COPY_READS_MAX. Nothing the person sees is cut: their packages are copied as before, a package whose
 * record cannot be read still fails the copy, and the record's own buyer still decides whose it is.
 *
 * Synthetic only: the in-memory Redis stub and a stand-in for Stripe; nothing real is reached.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { buyerField, buyerPackagesKey, packagesKey } from "@/lib/call-packages";
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
  // Each package in its buyer's index, as finishPackage writes it (#5125): no last day, so the set kept for good.
  const theirIndex = buyerPackagesKey(statsId, buyerField(PERSON), true);
  redis.run(["SADD", theirIndex, THEIRS]);
  redis.run(["SADD", buyerPackagesKey(statsId, buyerField(OTHER), true), ...OTHERS]);
  sessions = [paid(THEIRS, store.handle, "package"), paid(NOT_A_PACKAGE, store.handle)];
  const scope = (await erasureScope(store, PERSON))!;
  const copier = personCopy.COPIERS["lib/call-packages.ts"];

  part("Only the person's own packages are read");
  const first = await watched(() => copier(scope));
  is("their package is copied, as before", (first.records as { product: string; sessions: number }[] | null)?.map((c) => [c.product, c.sessions]), [["call000001", 4]]);
  is("RED: the store's whole set of packages is not read", first.commands.some((c) => c[1] === packagesKey(statsId)), false);
  is("RED: their own index, then one GET, their package's record, and nothing of the 60 other buyers", first.commands, [["SMEMBERS", buyerPackagesKey(statsId, buyerField(PERSON), false)], ["SMEMBERS", theirIndex], ["GET", `nl:pkg:${THEIRS}`]]);
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
  redis.run(["DEL", theirIndex]);
  redis.run(["SADD", theirIndex, ...many]);
  sessions = many.map((id) => paid(id, store.handle, "package"));
  const fresh = (await erasureScope(store, PERSON))!;
  const full = await watched(() => copier(fresh));
  is("a hundred packages of theirs, all copied", full.records?.length, 100);
  is("their index, then one GET each, within CALL_PACKAGE_COPY_READS_MAX", [full.commands.length, full.commands.length <= Number((personCopy as Record<string, unknown>).CALL_PACKAGE_COPY_READS_MAX)], [102, true]);

  part("A call package is bought only through a Stripe checkout on the creator's account (coord 2e8a)");
  // Reading the person's checkouts finds every package only if no other path writes one. Each fact below is read from
  // the code, so a new path (PayPal, an import, a gift) makes this fail rather than leave the copy incomplete.
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx|mjs|js|py)$/.test(e.name) ? [join(dir, e.name)] : []));
  const sources = ["lib", "app", "scripts"].flatMap(files).map((f) => [f, readFileSync(f, "utf8")] as const);
  const tracked = (pattern: string) => sources.filter(([, text]) => text.includes(pattern)).map(([f]) => f).sort();
  const packages = readFileSync("lib/call-packages.ts", "utf8");
  is("a package record is keyed by its checkout id (nl:pkg:<checkout>)", packages.includes("const pkgKey = (checkout: string) => `nl:pkg:${checkout}`;"), true);
  const recordWrites = [...packages.matchAll(/\["SET", pkgKey\(checkout\)[^\]]*\]/g)].map((m) => m[0]);
  is("two writes of a record: the first, SET NX, and the sessions held on an existing one", recordWrites.length, 2);
  is("the first is SET NX in recordPackage", /export async function recordPackage[\s\S]*?\["SET", pkgKey\(checkout\), JSON\.stringify\(bought\), "NX"/.test(packages), true);
  is("the other only rewrites a record read back first (holdSession)", /export async function holdSession[\s\S]*?const bought = await readBought\(checkout\);\s*if \(!bought\) return false;[\s\S]*?\["SET", pkgKey\(checkout\), JSON\.stringify\(bought\)/.test(packages), true);
  is("recordPackage writes only for a settled Stripe checkout marked kind \"package\"", packages.includes('if (meta.kind !== "package" || !SESSION_ID.test(checkout) || !isSettled(session) || !store.statsId) return null;'), true);
  is("the only other files naming nl:pkg: are the store's closing (it deletes) and the list of data families", tracked("nl:pkg:").filter((f) => f !== "lib/call-packages.ts"), ["lib/closed-store-data.ts", "lib/data-families.ts"]);
  is("recordPackage is called only for a Stripe checkout: the thanks page and the purchase email", tracked("recordPackage(").filter((f) => f !== "lib/call-packages.ts"), ["app/[handle]/thanks/page.tsx", "lib/purchase-email.ts"]);
  is("only the package checkout marks kind \"package\"", tracked('"metadata[kind]": "package"'), ["lib/call-packages.ts"]);
  is("PayPal never sells a call, so never a package of calls", readFileSync("lib/paypal-sales.ts", "utf8").includes("if (product.recurring || product.call || product.pwyw || product.keys || product.options.length > 0) return false;"), true);
  is("the person's checkouts are read for every handle the store sold under", readFileSync("lib/person-copy-stripe.ts", "utf8").includes("const handles = saleHandles(store);"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
