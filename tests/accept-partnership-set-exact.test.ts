/**
 * A partnership accepted from the studio goes through a short-lived grant written with SET and then opened
 * (lib/affiliates.ts acceptPartnership -> openAffiliateLink). Rule 24, rule 30 sibling of signInLinkFor
 * (claude5/signin-link-set-exact): a SET whose answer is anything but exactly "OK" is unknown, not a grant.
 *
 * Before: the answer was never read. A SET that did not land was opened as "expired", which the route gave back as a
 * 400 "unavailable", and the studio (components/affiliate-studio.tsx PartnerOffers) took a status under 500 for an
 * offer that is gone and took it off the list, although the offer was still kept.
 *
 * Now: acceptPartnership throws UnknownReplyError before anything is opened or charged; the route answers 503
 * "unavailable" (the studio's "This could not be done just now, so nothing was saved. Try again in a moment."),
 * the studio keeps the offer listed, the offer is kept, no partner record is made, and accepting again works.
 * Synthetic only: the in-memory Redis double, through the real route app/api/store/affiliates/route.ts.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, listAffiliates } from "@/lib/affiliates";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_accept_set_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

/** Runs `work` with every one-command SET of an affiliate link answered by `reply`; with `apply`, the SET still lands. */
async function setAnswered<T>(reply: unknown[], apply: boolean, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:aff:link:")) {
      if (apply) await original.call(redis, commands);
      return reply;
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Short, empty, other-shaped and lost answers to a SET: none of them is "stored". */
const ODD: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["an undefined reply", [undefined]],
  ["a reply of another word", ["QUEUED"]],
  ["two replies for one command", ["OK", "OK"]],
];

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.padEnd(15, "x").slice(0, 15)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  return async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; accepted?: boolean; waiting?: boolean } };
  };
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  const post = await shop(owner, "makershop");
  const made = await addProduct(owner, "Bread Basics", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const partner = async (email: string) => (await listAffiliates(await store())).find((p) => p.email === email) ?? null;

  part("1. Accepting from the studio with the grant's SET unconfirmed: a temporary failure, the offer kept");
  const answer = await shop("pat@example.com", "patshop");
  const left = await offerPartnership("pat@example.com", { sid: (await store()).sid, storeName: "makershop store", handle: "makershop", share: { percent: 20, products: [product] }, titles: ["Bread Basics"] });
  if (!left.ok) throw new Error("no offer");
  for (const apply of [false, true]) {
    for (const [what, reply] of ODD) {
      const got = await setAnswered(reply, apply, () => answer({ action: "answer", invite: left.id, accept: true }));
      is(`SET ${apply ? "made" : "not made"}, ${what}: 503 "unavailable", which the studio shows as try again and keeps the offer listed`, [got.status, got.body.error], [503, "unavailable"]);
    }
  }
  is("the offer is kept", (await waitingFor("pat@example.com")).map((w) => w.id), [left.id]);
  is("no partner record was made", await partner("pat@example.com"), null);

  part("2. acceptPartnership itself stops on the unknown answer, never reads it as an expired grant");
  const at = await store();
  for (const [what, reply] of ODD) {
    const got = await setAnswered(reply, false, () =>
      acceptPartnership(at, "lee@example.com", { percent: 10, products: [product] }).then(
        (r) => (r.ok ? "made" : r.reason),
        (error: unknown) => (error instanceof Error ? error.name : "thrown"),
      ));
    is(`${what}: UnknownReplyError, never "expired"`, got, "UnknownReplyError");
  }
  is("and nobody was written", await partner("lee@example.com"), null);

  part("3. Control: with Redis answering OK, accepting works as before");
  const yes = await answer({ action: "answer", invite: left.id, accept: true });
  is("the acceptance is made", [yes.status, yes.body.accepted], [200, true]);
  is("the partner holds the offered 20%", (await partner("pat@example.com"))?.share?.percent ?? null, 20);
  is("the offer is answered", (await waitingFor("pat@example.com")).length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
