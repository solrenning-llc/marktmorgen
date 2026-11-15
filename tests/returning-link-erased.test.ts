/**
 * #4769 (erasure, Codex L): a returning-buyer code link is never written back, or emailed, for a person the store
 * has deleted (Claude 7, 15/11/2026).
 *
 * sendReturningLink runs after the public answer. It looked up an old purchase still kept at Stripe, then SET a new
 * thirty-minute link holding the address and emailed it, without reading the store's deletion mark: a deletion made
 * before the lookup, or between it and the write, was undone by a link with the address and an email sent to it.
 * Now the link is written only by KEEP_UNLESS_ERASED (lib/suppression.ts keepUnlessErased), which reads the mark in
 * the same step: a deleted address gets no link and no email. The public answer is unchanged either way.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts; the email is a capture.
 */
import { RETURNING_LINK_SECONDS, sendReturningLink } from "@/lib/returning-code";
import { suppressCommand } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import type { ReturningCode } from "@/lib/returning-code-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_returning_link_erased_only";

const LIST = "listerased01";
const store = { handle: "returnshop", previousHandles: [], releasedHandles: [], name: "Return Shop", language: "en", stripeAccountId: "acct_1TestReturn0001", listId: LIST } as unknown as Store;
const CODE: ReturningCode = { code: "THANKYOU", coupon: "cpn_ReturnThanks01", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 };
const paid = {
  id: "cs_test_returningerased1", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 900, customer: null,
  metadata: { store: "returnshop", product: "prod_old" },
  payment_intent: { id: "pi_ReturnErased01", object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_ReturnErased01", object: "charge", refunded: false, amount_refunded: 0, disputed: false } },
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: [paid], has_more: false }));
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;

const sent: string[] = [];
const capture = (async (message: { to: string }) => {
  sent.push(message.to);
  return true;
}) as unknown as Parameters<typeof sendReturningLink>[6];
const links = () => redis.keys().filter((key) => key.startsWith("nl:rcode:link:"));
const send = (email: string) => sendReturningLink(store, "prod_new", "New Guide", CODE, email, "https://marktmorgen.com", capture);

async function main(): Promise<void> {
  part("A buyer who paid here before gets the link");
  redis.clear();
  await send("kept.buyer@example.com");
  is("one link, one email, to them", [links().length, sent], [1, ["kept.buyer@example.com"]]);
  const [ttl] = await redis.pipeline([["TTL", links()[0]]]);
  is("for the link's time", ttl, RETURNING_LINK_SECONDS);

  part("A person the store deleted gets neither");
  redis.clear();
  sent.length = 0;
  await redis.pipeline([suppressCommand(LIST, "erased.buyer@example.com")]);
  await send("erased.buyer@example.com");
  is("deleted before the lookup: no link, no email", [links().length, sent], [0, []]);

  redis.clear();
  const real = redis.pipeline.bind(redis);
  let reached = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The deletion lands after the old purchase was read, just before the link is written.
    if (!reached && commands.some((command) => command.some((part) => typeof part === "string" && part.startsWith("nl:rcode:link:")))) {
      reached = true;
      await real([suppressCommand(LIST, "late.erased@example.com")]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await send("late.erased@example.com");
  } finally {
    redis.pipeline = real;
  }
  is("the write was reached", reached, true);
  is("deleted between the lookup and the write: no link, no email", [links().length, sent], [0, []]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
