// The gift buyer's receipt says only what the email to the recipient carried. Found walking the buyer path (Claude 1,
// 12/11/2026): with "Your name, as they will see it" left empty, the recipient read "Someone bought you Pantry
// Checklist", and the buyer's receipt said "We emailed friend@example.com just now, with your name and a link to open
// it". Synthetic store, the in-memory database, Stripe and the email sender answered here; nothing is sent.
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { deliverGift, startGift } from "@/lib/gifts";
import { givingWords } from "@/lib/buyer-words/giving";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ id: `cs_test_${"n".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  if (path === "/refunds") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_name_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_gifts_only"; // a synthetic key already listed in tests/resend-fixture-credentials.ts
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Pantry Checklist", "", "9", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/pantry");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  const give = async (from: string, message: string, n: number) => {
    const started = await startGift(store, product, { to: "friend@example.com", from, message });
    if (!started.ok) throw new Error("no gift");
    await createCheckout(store, (await readProduct(store, product.id))!, "https://marktmorgen.com", "", { gift: started.gift.id, digitalConsent: TEST_CONSENT });
    emails.length = 0;
    await deliverGift({
      store,
      session: { id: `cs_test_${String(n).repeat(24)}`, created: 1_900_000_000, amount_total: 900, currency: "usd", payment_intent: `pi_GiftName000${n}`, metadata: { store: "harbor", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@example.com" } },
      product,
      base: "https://marktmorgen.com/@harbor",
      from: '"Harbor Kitchen" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => `https://marktmorgen.com/@harbor/orders?token=${"a".repeat(64)}`,
    });
    return { friend: emails.find((e) => e.to[0] === "friend@example.com")!, receipt: emails.find((e) => e.to[0] === "buyer@example.com")! };
  };

  part("No name typed: the recipient reads \"Someone\", and the receipt never says the buyer's name went");
  const nameless = await give("", "", 1);
  is("the recipient's email", nameless.friend.subject, "Someone sent you a gift: Pantry Checklist");
  is("the receipt says only the link went", nameless.receipt.text.includes("We emailed friend@example.com just now, with a link to open it."), true);
  is("and nothing of a name", nameless.receipt.text.includes("your name"), false);

  part("A name and a message: the receipt says both went");
  const named = await give("Ana", "Happy birthday!", 2);
  is("the recipient's email", named.friend.subject, "Ana sent you a gift: Pantry Checklist");
  is("the receipt", named.receipt.text.includes("We emailed friend@example.com just now, with your name, your message and a link to open it."), true);

  part("The same in every language of a store");
  const phrases: Record<string, [string, string]> = { es: ["tu nombre", "tu mensaje"], fr: ["votre nom", "votre message"], de: ["Ihrem Namen", "Ihrer Nachricht"], it: ["il tuo nome", "il tuo messaggio"], nl: ["je naam", "je bericht"], pt: ["o seu nome", "a sua mensagem"] };
  for (const [language, [name, message]] of Object.entries(phrases)) {
    const w = givingWords(language);
    const said = [[false, false], [true, false], [false, true], [true, true]].map(([n, m]) => w.weEmailed("x@example.com", n, m));
    is(`${language}: the name and the message are said only when they went`, said.map((s) => [s.includes(name), s.includes(message)]), [[false, false], [true, false], [false, true], [true, true]]);
  }
  is("es, as before when both went", givingWords("es").weEmailed("x@example.com", true, true).startsWith("Acabamos de enviar un email a x@example.com con tu nombre, tu mensaje y un enlace para abrirlo."), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
