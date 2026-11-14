/**
 * The payout batch file (app/api/store/affiliates/payout-batch, GET) is the
 * file the creator uploads to their own PayPal or Wise: whatever it lists is
 * paid at once, from the creator's own money. CX-123 rule 24: when the
 * refunds or the chargebacks on the creator's Stripe account could not be
 * read in full, the book is "not checked" (readBook's refundsChecked), what
 * is owed is not known, and the file must not be handed out, the same way
 * "Mark as paid" (POST) and payWithPayPal already refuse such a book.
 *
 * Checked with the real readBook, payableLines and batchFile over the Redis
 * stub, Stripe answered by a synthetic fetch, the signed-in creator from
 * tests/affiliate-payout-batch-route-world.ts:
 *
 *   - refunds unreadable: refused, no affiliate address or amount in the answer;
 *   - disputes unreadable: refused the same way;
 *   - refunds and disputes read in full: the file, as before (control);
 *   - nobody owed, confirmed: "Nobody is owed anything right now." (control).
 */
import type { NextRequest } from "next/server";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { GET } from "@/app/api/store/affiliates/payout-batch/route";
import { who } from "./affiliate-payout-batch-route-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_route_only";
process.env.RESEND_API_KEY = "re_test_payout_batch_route_only";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const ANA_EMAIL = "ana.payee@example.com";

let refundsWork = true;
let disputesWork = true;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return refundsWork ? answer({ object: "list", data: [], has_more: false }) : answer({ error: { message: "down" } }, 500);
  if (url.pathname === "/v1/disputes") return disputesWork ? answer({ object: "list", data: [], has_more: false }) : answer({ error: { message: "down" } }, 500);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 90 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string, aff: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 60 * 86_400, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });

const batch = async () => {
  const response = await GET(new Request("https://local.example/api/store/affiliates/payout-batch?provider=paypal") as unknown as NextRequest);
  return { status: response.status, body: await response.text(), type: response.headers.get("content-type") ?? "" };
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPayBatch", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  who.store = store;
  const statsId = store.statsId!;

  part("Nobody owed, confirmed (control)");
  const none = await batch();
  is("an empty book: nobody is owed", [none.status, none.body], [409, "Nobody is owed anything right now."]);

  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, ANA_EMAIL, "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:emails`, ANA_EMAIL, ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_bread1", sale("cs_bread1", ANA, 10_000)],
  ]);

  part("Refunds and disputes read in full (control)");
  const healthy = await batch();
  is("the file is handed out", healthy.status, 200);
  is("as a CSV", healthy.type.startsWith("text/csv"), true);
  const csvParts = healthy.body.trim().split(/\r?\n/)[0]?.split(",");
is("the PayPal row names the affiliate and contains exactly $30.00 in USD", [csvParts?.[0], csvParts?.[1], csvParts?.[2]], [`"${ANA_EMAIL}"`, "30.00", "USD"]);

  part("Refunds unreadable");
  refundsWork = false;
  const noRefunds = await batch();
  is("refused, not a file to pay from", noRefunds.status, 409);
  is("no CSV", noRefunds.type.startsWith("text/csv"), false);
  is("no affiliate address or amount in the answer", [noRefunds.body.includes(ANA_EMAIL), noRefunds.body.includes("30.00")], [false, false]);
  refundsWork = true;

  part("Disputes unreadable");
  disputesWork = false;
  const noDisputes = await batch();
  is("refused, not a file to pay from", noDisputes.status, 409);
  is("no CSV", noDisputes.type.startsWith("text/csv"), false);
  is("no affiliate address or amount in the answer", [noDisputes.body.includes(ANA_EMAIL), noDisputes.body.includes("30.00")], [false, false]);
  disputesWork = true;

  part("Read in full again");
  is("the file comes back", (await batch()).status, 200);

  done();
}

void main();
