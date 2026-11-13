/**
 * A gift's receipt says only what the recipient's email carried (#4316).
 *
 * The buyer's name and message are both optional on a gift. With no name
 * typed, the recipient's email says "Someone sent you a gift", so the
 * buyer's receipt must not say "with your name". Checked with the real
 * deliverGift, a stand-in Stripe and a stand-in email sender, and in every
 * buyer language through the words themselves.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, startGift } from "@/lib/gifts";
import { givingWords } from "@/lib/buyer-words/giving";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url.pathname}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_receipt_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_gifts_only";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Pantry Checklist", "", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/pantry");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  let n = 0;
  const give = async (from: string, message: string) => {
    n += 1;
    const started = await startGift(store, product, { to: `friend${n}@example.com`, from, message });
    if (!started.ok) throw new Error("no gift");
    emails.length = 0;
    await deliverGift({
      store,
      session: {
        id: `cs_test_${String(n).repeat(24)}`,
        created: 1_900_000_000,
        amount_total: 1900,
        currency: "usd",
        payment_intent: `pi_GiftReceipt${n}`,
        metadata: { store: "harbor", product: product.id, gift: started.gift.id },
        customer_details: { email: "buyer@example.com" },
      },
      product,
      base: "https://marktmorgen.com/@harbor",
      from: '"Harbor Kitchen" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => null,
    });
    return {
      theirs: emails.find((e) => e.to[0] === `friend${n}@example.com`),
      receipt: emails.find((e) => e.to[0] === "buyer@example.com")?.text ?? "",
    };
  };

  part("No name, no message");
  const bare = await give("", "");
  is("the recipient was told it is from someone", bare.theirs?.subject, "Someone sent you a gift: Pantry Checklist");
  is("the receipt says only the link went", bare.receipt.includes("We emailed friend1@example.com just now, with a link to open it."), true);
  is("and nothing of a name", /your name/.test(bare.receipt), false);

  part("A name, no message");
  const named = await give("Ana", "");
  is("the recipient was told it is from Ana", named.theirs?.subject, "Ana sent you a gift: Pantry Checklist");
  is("the receipt says the name and the link went", named.receipt.includes("with your name and a link to open it."), true);

  part("A message, no name");
  const said = await give("", "Enjoy!");
  is("the receipt says the message and the link went, and no name", [said.receipt.includes("with your message and a link to open it."), /your name/.test(said.receipt)], [true, false]);

  part("Both");
  const both = await give("Ana", "Enjoy!");
  is("the receipt says the name, the message and the link went", both.receipt.includes("with your name, your message and a link to open it."), true);

  part("Every buyer language names only what went");
  const nameWord: Record<string, string> = { es: "nombre", fr: "nom", de: "Namen", it: "nome", nl: "naam", pt: "nome" };
  for (const code of LANGUAGE_CODES) {
    if (code === "en") continue;
    const g = givingWords(code);
    const none = g.weEmailed("a@example.com", false, false);
    const all = g.weEmailed("a@example.com", true, true);
    is(`${code}: no name named when none went, and named when it did`, [none.includes(nameWord[code]), all.includes(nameWord[code])], [false, true]);
  }

  done();
}

void main();
