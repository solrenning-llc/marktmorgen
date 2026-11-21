/**
 * Codex X6's LOW on #2498 (6952386860): a membership link is emailed only after its token was stored. requestManageLink
 * wrote nl:manage:link:<hash> with a bare SET and sent the paid email whatever the reply said, so a lost or garbled
 * write delivered a dead link. Now an exact "OK" lets the email go; any other answer is read back by the token's own
 * value, so a write that landed with its reply lost still sends, and one that did not (or does not read) sends
 * nothing and the form says something went wrong (CX-123 rule 24). Synthetic store, the tests' in-memory Redis, a stubbed Stripe and Resend.
 */
import { requestManageLink } from "@/lib/membership-manage";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const account = "acct_1TestClubToken01";
const customer = "cus_MemberToken001";
const origin = "https://marktmorgen.com";
const emails: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const reply = (value: unknown) => new Response(JSON.stringify(value));
  if (url.hostname === "api.resend.com") {
    emails.push(url.pathname);
    return reply({ id: "email_1" });
  }
  if (url.hostname !== "api.stripe.com") throw Error("Unexpected provider");
  if (url.pathname === "/v1/customers") return reply({ object: "list", data: [{ id: customer, object: "customer", email: "member@example.com" }], has_more: false });
  if (url.pathname === "/v1/subscriptions") return reply({ object: "list", data: [{ id: "sub_MemberToken01", object: "subscription", customer, status: "active", created: 1_790_000_000, metadata: { store: "tokenclub" } }], has_more: false });
  throw Error(`Unexpected Stripe operation ${url.pathname}`);
}) as typeof fetch;

const isTokenWrite = (c: (string | number)[]) => c[0] === "SET" && String(c[1]).startsWith("nl:manage:link:");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_member_token_write";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const setup = async () => {
    await claimHandle("club@example.com", "tokenclub", "Token Club", "");
    await ensureStatsId("club@example.com");
    await setSubscription("club@example.com", { customerId: "cus_TokenClubOwner1", subscriptionId: "sub_TokenClubOwner1", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
    await setStripeAccount("club@example.com", account, true);
  };
  await setup();
  const store = (await storeForEmail("club@example.com"))!;
  const original = redis.pipeline.bind(redis);
  let ip = 10;
  const ask = async () => {
    ip += 1;
    try { return await requestManageLink({ store, email: "member@example.com", ip: `203.0.113.${ip}`, origin }); } catch { return "threw"; }
  };

  part("Control: a token stored exactly is emailed");
  emails.length = 0;
  const healthy = await ask();
  is("the link is emailed once its token is stored", [healthy, emails.length], ["sent", 1]);

  part("A token write answered in any other shape: emailed only when the token is read back as stored");
  for (const [label, reply, lands] of [
    ["a lost reply, the write landed", [], true],
    ["a lost reply, the write did not land", [], false],
    ["a null reply (not stored)", [null], false],
    ["a queued reply, the write landed", ["QUEUED"], true],
    ["an error entry (not stored)", [{ error: "ERR synthetic" }], false],
  ] as [string, unknown[], boolean][]) {
    redis.clear();
    await setup();
    emails.length = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some(isTokenWrite)) {
        if (lands) await original(commands);
        return reply;
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let result: unknown;
    try { result = await ask(); } finally { redis.pipeline = original; }
    is(`${label}: ${lands ? "read back as stored, emailed once" : "no email, and the form is not told \"sent\""}`, [result === "sent", emails.length], lands ? [true, 1] : [false, 0]);
  }
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
