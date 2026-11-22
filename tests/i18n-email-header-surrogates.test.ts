/**
 * A subject or a From name is cut to a length before it is sent (a subject at
 * 200, a store's name at 60, every header in lib/email.ts headerText). A
 * product title or a store name with an emoji or another character outside
 * the Basic Multilingual Plane is two UTF-16 units, and a cut between them
 * left half a character: a lone surrogate, which is not text at all and
 * reaches the buyer as "�" or makes the message refused.
 *
 * What is checked is what would be sent: the body handed to the email
 * provider, for a buyer's purchase confirmation (lib/purchase-email.ts), in
 * every store language, with the cut falling at each place in the emoji.
 * Synthetic store and buyer; fetch is a stand-in that records the request.
 */
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmPurchase, confirmationFor } from "@/lib/purchase-email";
import { headerText } from "@/lib/email";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { from: string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    for (const one of Array.isArray(body) ? body : [body]) sent.push(one as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "owner@example.com";
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const whole = (s: string) => !LONE.test(s);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_surrogate_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("headerText never leaves half a character");
  for (let n = 245; n <= 252; n += 1) {
    is(`a header cut at 250 after ${n} letters and emoji`, whole(headerText(`${"a".repeat(n)}🍞🍞🍞🍞`)), true);
  }
  is("a lone half already in the text is dropped, not sent", headerText("Bread \uD83C shop"), "Bread shop");
  is("whole emoji and accents are kept as they are", headerText("Ünïcødé 🍞 مخبز שלום"), "Ünïcødé 🍞 مخبز שלום");

  part("The purchase confirmation as sent, in every store language");
  // A store name of 59 letters and an emoji: the From name is cut at 60, between the emoji's two halves.
  await claimHandle(OWNER, "breadloft", `${"B".repeat(59)}🍞`, "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBreadLoft1", true);
  await setSubscription(OWNER, { customerId: "cus_Surrogate0001", subscriptionId: "sub_Surrogate0001", active: true, period: paidPeriod() });
  // Two titles of emoji, one letter apart, so the subject's cut at 200 falls inside an emoji in one of them.
  const titles = ["🍞".repeat(120), `a${"🍞".repeat(120)}`];
  const ids: string[] = [];
  for (const title of titles) {
    const made = await addProduct(OWNER, title, "", "12", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, "https://example.com/bread");
    ids.push(made.product.id);
  }
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  let split = 0;
  for (const language of LANGUAGE_CODES) {
    await setLanguage(OWNER, language);
    const store = (await storeForEmail(OWNER))!;
    for (const id of ids) {
      n += 1;
      const sessionId = `cs_test_surrogate${String(n).padStart(6, "0")}`;
      const session = {
        id: sessionId, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
        currency: "jpy", amount_total: 1999, created: now, customer_details: { email: "buyer@example.com" },
        metadata: { store: "breadloft", product: id },
      };
      const listing = (await readListing(store, id))!;
      if (!whole(confirmationFor(store, session as never, now, [], [listing])?.subject ?? "")) split += 1;
      const before = sent.length;
      is(`${language}: sent`, await confirmPurchase(store, sessionId, session as never), "sent");
      const mail = sent[before];
      is(`${language}: the subject is whole text`, whole(mail?.subject ?? "\uD800"), true);
      is(`${language}: the From line is whole text`, whole(mail?.from ?? "\uD800"), true);
      is(`${language}: the amount is the yen as charged`, /1[.,   ]?999/.test(mail?.text ?? ""), true);
    }
  }
  is("the cut did fall inside an emoji in the subjects built (so the checks above are real)", split > 0, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
