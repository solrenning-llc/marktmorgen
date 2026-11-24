/**
 * Claude 3 xvBY8 on #5095 (LEVE 4): the studio's notices for a Stripe connection press (app/studio/page.tsx
 * STRIPE_NOTICES, attemptCountryNotice, STORES_NOTICES.stripe_connecting) were drawn by no test: removing any passed.
 * Each answer the connect route and the store deletion give is drawn here on the real studio page, with its words; and
 * attempt-held's words hold for both cases that land on it (another address, or the same details past the 29 days).
 * Synthetic store and session; MemoryRedis (tests/redis-stub.ts).
 */
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { beginStripeConnect, claimHandle, ensureStatsId, storeForEmail, storeRef } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

/** Every string drawn, with the page's async parts awaited. */
async function walk(node: unknown, text: string[], seen = new Set<unknown>()): Promise<void> {
  if (typeof node === "string") {
    text.push(node);
    return;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return walk(await node, text, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => walk(child, text, seen)));
    return;
  }
  if (isValidElement(node)) await Promise.all(Object.values(node.props as Record<string, unknown>).map((value) => walk(value, text, seen)));
}

async function drawn(session: string, params: Record<string, string>): Promise<string> {
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  try {
    const text: string[] = [];
    await walk(await StudioPage({ searchParams: Promise.resolve(params) }), text);
    return text.join("\n");
  } finally {
    answering(null);
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const OWNER = "studio-stripe-notices@example.com";
  await claimHandle(OWNER, "studiostripenotices", "Stripe notices", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);

  part("Each answer of the connect route is drawn with its own words");
  const cases: [string, string][] = [
    ["attempt-held", "Your last try may still be opening your account"],
    ["store-full", "Your store record is full"],
    ["attempt-refused", "Stripe refused this try, and an earlier one may have opened your account"],
    ["attempt-country", "An account is still being opened in another country"],
    ["country-unsupported", "Stripe will not open an account in that country from here"],
  ];
  for (const [code, title] of cases) is(`stripe=${code}`, (await drawn(session, { stripe: code })).includes(title), true);

  part("attempt-held's words hold for both cases that land on it");
  const held = await drawn(session, { stripe: "attempt-held" });
  is("it never says the details are what differ", /other details/.test(held), false);
  is("it says when to try again", /one day after your last try/.test(held), true);

  part("An open attempt in another country is named");
  const store = await storeForEmail(OWNER);
  if (!store) throw new Error("no store");
  await beginStripeConnect(storeRef(store), store.sid, { country: "gb", email: OWNER, name: "Notices" });
  is("the country's name is said", (await drawn(session, { stripe: "attempt-country" })).includes("An account in United Kingdom is still being opened"), true);

  part("A store held from its deletion by an open attempt says so");
  is("stores=stripe_connecting", (await drawn(session, { stores: "stripe_connecting" })).includes("This store's Stripe account is still being opened"), true);
  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
