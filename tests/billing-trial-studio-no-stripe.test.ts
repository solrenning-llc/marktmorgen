/**
 * Claude 2's first money review of #3337 (MEDIUM): the once-per-person trial must be read at Stripe only in the
 * checkout, which is already bounded (one customer search and at most six subscription lists per checkout). The
 * studio's home (app/studio/page.tsx) and its email page (app/studio/email/page.tsx) are loaded far more often than
 * a checkout is opened, by every new creator and every free account; a Stripe Search read there is unmetered, in no
 * registry, and shares Stripe's Search API rate limit with the checkout's own subscription search. A planless store
 * loading either page therefore makes no Stripe request at all; its buttons keep the store rule (trialOffered), and
 * Stripe's own Checkout page shows the amount due today before any charge.
 *
 * Measured with the real pages, a real store with no plan, paid plans on sale (tests/billing-trial-studio-opening.ts)
 * and billing configured: every request to api.stripe.com is counted. Synthetic only.
 */
import { isValidElement } from "react";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { PLANS_ON_SALE } from "@/lib/opening";
import { isBillingConfigured, trialOffered } from "@/lib/billing";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import StudioEmailPage from "@/app/studio/email/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_studio_no_stripe_only_a_stand_in";

const stripe: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.stripe.com") {
    stripe.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/customers/search") return Response.json({ object: "search_result", data: [], has_more: false, next_page: null });
    return Response.json({ object: "list", data: [], has_more: false });
  }
  return Response.json({ object: "list", data: [], blobs: [], has_more: false, hasMore: false });
}) as typeof fetch;

/** Renders a server tree as React does: promises waited for, async components run, siblings together. */
async function render(node: unknown): Promise<void> {
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node);
  if (Array.isArray(node)) {
    await Promise.all(node.map(render));
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props));
  await Promise.all(Object.values(props).map(render));
}

async function load(page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>, path: string, cookie: string): Promise<{ loaded: boolean; stripe: string[] }> {
  stripe.length = 0;
  let loaded = true;
  try {
    answering(new NextRequest(`https://marktmorgen.com${path}`, { headers: { cookie } }));
    await render(await page({ searchParams: Promise.resolve({}) }));
  } catch (error) {
    loaded = false;
    console.log(error);
  } finally {
    answering(null);
  }
  return { loaded, stripe: [...stripe] };
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "trial-studio-no-stripe@example.com";
  is("(setup) the store is made", (await claimHandle(OWNER, "trialstudionostripe", "Trial Studio", "")).ok, true);
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  is("(setup) paid plans on sale, billing configured, a store that never had a plan and is offered the trial", [PLANS_ON_SALE, isBillingConfigured(), store.subscriptionId ?? null, store.stripeCustomerId ?? null, trialOffered(store)], [true, true, null, null, true]);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  part("A planless store loads the studio: no Stripe request");
  is("the studio's home loads for its owner, with no Stripe request", await load(StudioPage as never, "/studio", cookie), { loaded: true, stripe: [] });

  part("A planless store loads the email page: no Stripe request");
  is("the email page loads for its owner, with no Stripe request", await load(StudioEmailPage as never, "/studio/email", cookie), { loaded: true, stripe: [] });
  done();
}

main().catch((error: unknown) => {
  console.log(error);
  process.exit(1);
});
