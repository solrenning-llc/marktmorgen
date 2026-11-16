/**
 * Proof (CX-123 rule 24 and rule 30), MÉDIO, for Revisor 2 to reproduce; not a
 * test in the CI run, and nothing in the code is changed by it.
 *
 * lib/buyer-library.ts storesKnownFor (the sibling of storesBoughtFrom, which
 * the same branch makes exact) reads its SUNION through `ids()`: anything but
 * an array becomes [], and a non-string member is dropped. [] is also the
 * answer for an address no store knows. Its two callers act on that:
 *
 *   - lib/erasure-request.ts:149: a person asking to be deleted from every
 *     store gets no deletion link, and nothing is logged, because "no store
 *     knows this address" is not a failure (the page says "sent" either way,
 *     by design, so the person is never told).
 *   - lib/person-copy.ts:320: the person's copy of their data leaves out the
 *     note that they are in the store's library (a data-access answer that
 *     says less than is kept).
 *
 * Each check below states the honest outcome, so the unknown cases FAIL on
 * main today; the controls pass. Synthetic stores; one reply injected per
 * case; no network.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: (() => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "SUNION")) return inject();
  return real(batch);
}) as typeof redis.pipeline;

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { to?: unknown }).to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this proof: ${url.hostname}`);
}) as typeof fetch;

const logged: string[] = [];
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_LibKnown", true);
  await setSubscription(owner, { customerId: "cus_LibKnownProof1", subscriptionId: "sub_LibKnownProof1", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

let ip = 0;
async function askAll(email: string): Promise<void> {
  ip += 1;
  await eraseRoute(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` },
      body: new URLSearchParams({ action: "ask", email, scope: "all" }),
    }),
  );
  // What the route leaves for after its answer.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_library_known_proof_stand_in";
  const shop = await paidStore("lib-known-proof");
  const KNOWN = "bought-at-shop@example.com";
  // One address per ask below, each known to the store, so the hourly limit per address never decides it.
  const addresses = ["bought-a@example.com", "bought-b@example.com", "bought-c@example.com"];
  await rememberBuyers(shop.sid, [KNOWN, ...addresses]);

  part("Controls: whole readings");
  is("the address is known to the store", await storesKnownFor(KNOWN), [shop.sid]);
  is("an address nobody knows is known to no store", await storesKnownFor("nobody-anywhere@example.com"), []);
  // The ask reaches the sending step: the link is emailed, or its failure is logged ("was not emailed: ...").
  // In this harness the sender stand-in answers "error", which is logged; what matters is that the step is reached.
  let from = sent.length;
  let before = logged.length;
  await askAll(KNOWN);
  is("asked to be deleted everywhere, the known address reaches the sending step (emailed or logged)", sent.length > from || logged.length > before, true);

  const cases: [string, () => unknown[]][] = [
    ["the stores answered as a string", () => ["x"]],
    ["a number among the stores", () => [[shop.sid, 7]]],
    ["no reply at all", () => []],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    is("storesKnownFor says the reading is unknown, never 'no store knows it'", await storesKnownFor(KNOWN).then((ids) => (ids.length ? "known" : "none"), () => "unknown"), "unknown");
    from = sent.length;
    before = logged.length;
    await askAll(addresses.shift()!);
    inject = null;
    is("the deletion ask is either emailed or leaves a trace in the log, never dropped in silence", sent.length > from || logged.length > before, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
