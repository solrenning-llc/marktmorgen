import { done, is, part } from "./check";
import { StripeUnreadableReply, stripeJson } from "@/lib/stripe-http-error";

// stripeJson (lib/stripe-http-error.ts) reads a Stripe answer's text so a status that is not OK with a body that is
// not JSON keeps its status (StripeUnreadableReply). A test's stand-in that replaces json() on a real Response hands
// back values JSON cannot carry (NaN, Infinity: tests/list-sales-amount-exact.test.ts); reading its text instead
// would lose them and read the placeholder body. Synthetic answers only; nothing leaves this process.

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  part("A stand-in that replaced json() is read through it, never through its placeholder text");
  const ok = new Response("{}", { status: 200 });
  Object.defineProperty(ok, "json", { value: async () => ({ data: [{ amount_total: Number.NaN }], has_more: false }) });
  const read = await stripeJson(ok);
  is("the page is the stand-in's own", Array.isArray(read.data), true);
  is("a value JSON cannot carry reaches the reader", Number.isNaN((read.data as { amount_total: number }[])[0].amount_total), true);
  const refused = new Response("{}", { status: 403 });
  Object.defineProperty(refused, "json", { value: async () => ({ error: { code: "account_invalid" } }) });
  is("a refusing stand-in keeps its own error", ((await stripeJson(refused)).error as { code: string }).code, "account_invalid");

  part("A stand-in with only json() is read as before");
  const bare = { ok: true, status: 200, json: async () => ({ id: "cus_StandIn1" }) } as unknown as Response;
  is("its json() is read", (await stripeJson(bare)).id, "cus_StandIn1");

  part("A real answer is still read from its text");
  is("JSON is read", (await stripeJson(new Response('{"id":"cus_Real1"}', { status: 200 }))).id, "cus_Real1");
  const page = await caught(() => stripeJson(new Response("<html>502 Bad Gateway</html>", { status: 502 })));
  is("a gateway page that is not JSON is unreadable, its status kept", page instanceof StripeUnreadableReply && page.status === 502, true);
  const odd = await caught(() => stripeJson(new Response("<html>ok</html>", { status: 200 })));
  is("an OK answer that is not JSON stays a SyntaxError", odd instanceof SyntaxError, true);

  done();
}
void main();
