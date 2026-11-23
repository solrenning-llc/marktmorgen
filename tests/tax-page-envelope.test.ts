/**
 * The whole draw of the studio's "Where you collect tax" page (app/studio/tax/page.tsx), at its worst, against
 * what a studio request is priced at (tests/plan-cost-registry.ts, UNIT_COST.studio: twenty commands, TAKE_COMMANDS
 * and LOCKED_UNTIL_STAR_COMMANDS, fifty kilobytes). Since #5160 (Codex L-20261119-1643) the page's kept copy of the
 * tax registrations is written through the store's fence (lib/store-live-cache.ts setWhileStoreLive: one EVAL that
 * runs HGET, GET and SET) instead of a plain SET; this holds the page, with that fence, inside its priced unit.
 *
 * Worst case: a live store with a Stripe account connected and no kept copy, so Stripe is read and the fenced write
 * runs. Every command the page sends is counted as sent, an EVAL as one, plus every command run inside a script
 * (the stand-in's scriptCalls, and the commands of the scripts mirrored in lib/redis-memory-take.ts, which the
 * stand-in runs without counting them), plus TAKE_COMMANDS and LOCKED_UNTIL_STAR_COMMANDS as UNIT_COST.studio takes
 * them. The session, the page's authorization (lib/studio-route.ts studioView) and the database code are real; only
 * the request context, the studio's header and pin (tests/aliases/tax-page-envelope.test.ts.json) and Stripe (a
 * fetch stand-in) are not. Synthetic data only; nothing real is reached.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import StudioTaxPage from "@/app/studio/tax/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MemoryRedis } from "@/lib/redis-memory";
import { TAKE_SCRIPTS } from "@/lib/redis-memory-take";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { done, is, part } from "./check";

type Command = (string | number)[];
process.env.STRIPE_SECRET_KEY = "sk_test_tax_page_envelope_stand_in";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const OWNER = "tax-envelope@example.com";
const ACCOUNT = "acct_1TaxEnvelope01";
const KEPT = `nl:taxreg:${ACCOUNT}`;
const reg = (id: string, state: string) => ({
  id, object: "tax.registration", active_from: 1_782_000_000, country: "US",
  country_options: { us: { state, type: "state_sales_tax" } }, created: 1_781_000_000, expires_at: null, livemode: false, status: "active",
});
let stripeReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com" || url.pathname !== "/v1/tax/registrations") return new Response("{}", { status: 404 });
  stripeReads += 1;
  return new Response(JSON.stringify({ object: "list", data: [reg("taxreg_ENV1", "CA"), reg("taxreg_ENV2", "NY")], has_more: false }), { status: 200 });
}) as typeof fetch;

// Every command the page sends, as sent.
const sent: Command[] = [];
const pipeline = redis.pipeline;
redis.pipeline = async (commands: Command[]) => {
  sent.push(...commands);
  return pipeline(commands);
};
// The scripts mirrored in lib/redis-memory-take.ts run their commands outside the stand-in's scriptCalls; each one
// they run is counted here (tests/redis-memory-take-scripts.test.ts holds the mirror to the stand-in's own scripts).
let mirrored = 0;
const run = redis.run;
const plain = MemoryRedis.prototype.run;
redis.run = (command: Command): unknown => {
  const name = command[0] === "EVAL" ? /^-- marktmorgen:([a-z-]+:v\d+)\n/.exec(String(command[1]))?.[1] ?? "" : "";
  if (name && Object.hasOwn(TAKE_SCRIPTS, name)) {
    const count = Number(command[2]);
    const rest = command.slice(3).map(String);
    return TAKE_SCRIPTS[name]((inner) => {
      mirrored += 1;
      return plain.call(redis, inner);
    }, rest.slice(0, count), rest.slice(count));
  }
  return run(command);
};

async function draw(): Promise<{ html: string; external: number; scriptCalls: number; mirrored: number; evals: number; measured: number }> {
  sent.length = 0;
  mirrored = 0;
  const before = redis.scriptCalls;
  const page = await StudioTaxPage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page));
  const scriptCalls = redis.scriptCalls - before;
  const external = sent.length;
  const measured = external + scriptCalls + mirrored + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  return { html, external, scriptCalls, mirrored, evals: sent.filter((c) => c[0] === "EVAL").length, measured };
}

async function main(): Promise<void> {
  redis.clear();
  cookieValues.clear();
  if (!(await claimHandle(OWNER, "taxenvelope", "Tax Envelope", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TaxEnvelope1", subscriptionId: "sub_TaxEnvelope1", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  is("a live store with an id and the account connected", [Boolean(store.sid), store.stripeAccountId], [true, ACCOUNT]);
  cookieValues.set(SESSION_COOKIE, await openSession(OWNER));

  const envelope = UNIT_COST.studio;
  const results: Awaited<ReturnType<typeof draw>>[] = [];
  for (const label of ["first draw", "a later draw, the kept copy gone"]) {
    part(`The page, ${label}: no kept copy, Stripe read, the fenced write runs`);
    await pipeline([["DEL", KEPT]]);
    stripeReads = 0;
    const got = await draw();
    results.push(got);
    console.log("TAX_PAGE_ENVELOPE", JSON.stringify({ draw: label, external: got.external, evals: got.evals, scriptCalls: got.scriptCalls, mirrored: got.mirrored, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured: got.measured, unitCommands: 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, measuredUsd: request("studio", got.measured, 50_000), envelopeUsd: envelope }));
    is("the page drew the registrations Stripe returned", [stripeReads, got.html.includes("California"), got.html.includes("New York")], [1, true, true]);
    is("the copy was kept through the store's fence", Number(await pipeline([["EXISTS", KEPT]]).then((r) => r[0])), 1);
    is("the fenced write ran in this draw (its commands counted)", got.mirrored >= 3, true);
    is(`the whole draw (${got.measured} commands) is inside one studio request as priced (${20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS})`, request("studio", got.measured, 50_000) <= envelope, true);
  }

  part("With the copy kept, nothing more is written and Stripe is not asked");
  stripeReads = 0;
  const kept = await draw();
  console.log("TAX_PAGE_ENVELOPE", JSON.stringify({ draw: "kept copy read", external: kept.external, evals: kept.evals, scriptCalls: kept.scriptCalls, mirrored: kept.mirrored, measured: kept.measured }));
  is("read from the kept copy", [stripeReads, kept.mirrored, kept.html.includes("California")], [0, 0, true]);
  is("never more than the worst draw above", kept.measured <= Math.max(...results.map((r) => r.measured)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
