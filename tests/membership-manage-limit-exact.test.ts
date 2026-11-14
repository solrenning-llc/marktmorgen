/**
 * The membership "manage" link's rate limits read their count exactly (CX-123 rule 24): a count that is missing,
 * null or of another shape is never taken as room. Until 14 November 2026 `within` (lib/membership-manage.ts) took
 * `Number(count) <= limit`, so a null count read as 0 and let the request through to the creator's Stripe account.
 * Synthetic store, Redis stand-in and Stripe stand-in only.
 */
import { requestManageLink } from "@/lib/membership-manage";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner-manage-limit@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    stripeCalls += 1;
    return Response.json({ object: "list", data: [], has_more: false });
  }
  if (url.hostname === "api.resend.com") return Response.json({ id: "email_manage_limit" });
  throw new Error(`Unexpected provider: ${url.hostname}`);
}) as typeof fetch;

/** Every INCR answered with `reply` in place of its count, the rest as Redis would. */
function incrAnswers(reply: unknown): () => void {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = (await real(commands)) as unknown[];
    return replies.map((one, i) => (String(commands[i]?.[0]).toUpperCase() === "INCR" ? reply : one));
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real;
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_limit_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_manage_limit_only_a_stand_in";
  await claimHandle(OWNER, "limitclub", "Limit Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLimit00001", true);
  const store = (await storeForEmail(OWNER))!;

  for (const [name, reply] of [
    ["null", null],
    ["a word", "QUEUED"],
    ["zero", 0],
  ] as const) {
    part(`A rate limit counted as ${name}: refused, nothing asked of Stripe`);
    stripeCalls = 0;
    const restore = incrAnswers(reply);
    let result: unknown;
    try {
      result = await requestManageLink({ store, email: "member@example.com", ip: "192.0.2.10", origin: "https://example.com" });
    } finally {
      restore();
    }
    is(`${name}: never "sent"`, result === "sent", false);
    is(`${name}: Stripe was not asked`, stripeCalls, 0);
  }

  part("A count read exactly still lets a request in");
  stripeCalls = 0;
  const result = await requestManageLink({ store, email: "member@example.com", ip: "192.0.2.11", origin: "https://example.com" });
  is("counted: answered as usual", result, "sent");
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
