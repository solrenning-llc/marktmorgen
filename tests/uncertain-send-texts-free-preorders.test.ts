/**
 * A free copy's or a pre-order's email whose send is not known (rule 30, a
 * sibling of 283 [HG2] unit 1's sendEmailOutcome): lib/free.ts requestCopy,
 * app/api/store/free/route.ts and the free copy's page words
 * (lib/buyer-words/giving.ts freeNotices), and lib/preorders.ts
 * confirmPreorder and resendPreorder.
 *
 * Found 9 November 2026: a sender's answer that was not known (a 5xx, a
 * network error after the request may have reached it) was taken for "not
 * sent". The buyer of a free copy read "We could not send it just now.
 * Nothing was kept. Try again in a moment", while the email may have arrived
 * with a link that works, and the copy was left out of the month's orders;
 * a pre-order's receipt was answered "failed", so the studio said to try
 * again and the mark of its first send was let go. Checked:
 *
 *   - free copy, the sender answers 500 or the request throws: "uncertain",
 *     counted as one of the month's orders (it may have arrived), and the
 *     route sends the buyer to the page with status=uncertain;
 *   - the page's words for it in every language of the store, each saying it
 *     could not be confirmed, that it may still arrive, and to check before
 *     asking again;
 *   - free copy, a 422 (a certain refusal): "error", not counted (control);
 *   - pre-order, the receipt answered 500 at confirmation: "uncertain",
 *     never "failed", so its mark is kept; resend answered 500: "uncertain";
 *     a 422: "failed" as before; a plain yes: "sent" (controls).
 *
 * Synthetic stores; the sender is a stand-in for `fetch`, so no real email
 * is sent.
 */
import { NextRequest } from "next/server";
import { POST as freeRoute } from "@/app/api/store/free/route";
import { givingWords } from "@/lib/buyer-words/giving";
import { requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { storeOrdersThisMonth } from "@/lib/orders";
import { confirmPreorder, resendPreorder } from "@/lib/preorders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

let posts = 0;
let senderAnswer: (() => Response) | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    posts += 1;
    if (senderAnswer) return senderAnswer();
    return new Response(JSON.stringify({ id: `email_${posts}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const REFUSED = () => new Response(JSON.stringify({ message: "not a valid address" }), { status: 422 });
const THROWN = () => { throw new TypeError("network error"); };

const UNSURE: Record<LanguageCode, { title: string; body: string }> = {
  en: { title: "We could not confirm it was sent", body: "It may still arrive. Check your inbox and spam folder before you ask for it again." },
  es: { title: "No hemos podido confirmar que se haya enviado", body: "Puede que aún llegue. Revisa tu bandeja de entrada y la carpeta de spam antes de volver a pedirla." },
  fr: { title: "Nous n'avons pas pu confirmer l'envoi", body: "Il peut encore arriver. Vérifiez votre boîte de réception et vos spams avant de le redemander." },
  de: { title: "Wir konnten den Versand nicht bestätigen", body: "Die E-Mail kann noch ankommen. Sehen Sie in Ihrem Posteingang und im Spam-Ordner nach, bevor Sie das Exemplar erneut anfordern." },
  it: { title: "Non siamo riusciti a confermare l'invio", body: "L'email potrebbe arrivare comunque. Controlla la posta in arrivo e lo spam prima di richiedere di nuovo la copia." },
  nl: { title: "We konden niet bevestigen dat het is verstuurd", body: "De e-mail kan nog aankomen. Kijk in je inbox en je spam voordat je het exemplaar opnieuw aanvraagt." },
  pt: { title: "Não foi possível confirmar o envio", body: "O email ainda pode chegar. Verifique a caixa de entrada e a pasta de spam antes de pedir o exemplar novamente." },
};

async function main(): Promise<void> {
  redis.clear();

  part("Free copy: the sender's answer not known");
  const owner = "owner-free-unsure@example.com";
  await claimHandle(owner, "freeunsure", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_FreeUnsure01", subscriptionId: "sub_FreeUnsure01", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pantry Guide", "", "0", null);
  if (!made.ok) throw new Error("Synthetic free product was refused");
  await setProductLink(owner, made.product.id, "https://example.com/pantry-guide.pdf");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  const ask = async (email: string, ip: string, answer: (() => Response) | null) => {
    senderAnswer = answer;
    const result = await requestCopy({ store, product, email, consent: false, ip, origin: "https://example.com" });
    senderAnswer = null;
    return result;
  };

  let orders = (await storeOrdersThisMonth(store))!;
  is("a 500: uncertain, never error", await ask("ana-free@example.com", "192.0.2.10", SERVER_ERROR), "uncertain");
  is("counted as one of the month's orders: it may have arrived", (await storeOrdersThisMonth(store))! - orders, 1);
  orders = (await storeOrdersThisMonth(store))!;
  is("a thrown request: the same", await ask("ben-free@example.com", "192.0.2.11", THROWN), "uncertain");
  is("and counted", (await storeOrdersThisMonth(store))! - orders, 1);
  orders = (await storeOrdersThisMonth(store))!;
  is("a 422: error, as before (control)", await ask("cal-free@example.com", "192.0.2.12", REFUSED), "error");
  is("not counted (control)", (await storeOrdersThisMonth(store))! - orders, 0);
  is("a plain yes: sent (control)", await ask("dot-free@example.com", "192.0.2.13", null), "sent");

  senderAnswer = SERVER_ERROR;
  const response = await freeRoute(
    new NextRequest("https://marktmorgen.com/api/store/free", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.14", origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: new URLSearchParams({ handle: "freeunsure", product: product.id, email: "eve-free@example.com" }),
    }),
  );
  senderAnswer = null;
  is("the route sends the buyer to the page with status=uncertain", [response.status, /[?&]status=uncertain(&|$)/.test(response.headers.get("location") ?? "")], [303, true]);

  part("Free copy: the page's words in every language of the store");
  for (const code of LANGUAGE_CODES) {
    const notice = givingWords(code).freeNotices.uncertain;
    is(`${code}: not confirmed, may still arrive, check before asking again`, notice, UNSURE[code]);
    is(`${code}: never the words of a certain failure`, notice?.title === givingWords(code).freeNotices.error.title, false);
  }

  part("Pre-order: the sender's answer not known");
  const STATS = "u".repeat(32);
  const shop = { sid: "sidpreunsure1", handle: "bakeryunsure", name: "Oven Notes", email: "owner-pre@example.com", previousHandles: [], releasedHandles: [], statsId: STATS, currency: "usd", language: "en", stripeAccountId: "acct_test_preunsure01", pastBuyers: true } as unknown as Store;
  const book = { id: "breadunsure1", title: "The Bread Book", course: null, priceCents: 2500 } as unknown as Listing;
  const session = (n: number, email: string) => ({
    id: `cs_test_preunsure${String(n).padStart(6, "0")}`,
    created: Math.floor(Date.now() / 1000) - 60,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: `pi_preunsure${String(n).padStart(6, "0")}`,
    metadata: { store: "bakeryunsure", product: book.id, preorder: "yes" },
    customer_details: { email },
  }) as unknown as Parameters<typeof confirmPreorder>[1];
  const deps = { base: "https://marktmorgen.com/@bakeryunsure", from: "Oven Notes <hello@example.com>", ordersLink: async () => null, recordStart: async () => {} };
  await redis.pipeline([["SADD", `nl:wl:${STATS}:soon`, book.id]]);

  senderAnswer = SERVER_ERROR;
  const confirmed = await confirmPreorder(shop, session(1, "ana-pre@example.com"), book, deps);
  senderAnswer = null;
  is("the receipt answered 500 at confirmation: uncertain, never failed", confirmed, "uncertain");
  senderAnswer = SERVER_ERROR;
  const resent = await resendPreorder(shop, session(1, "ana-pre@example.com") as Parameters<typeof resendPreorder>[1], book, deps);
  senderAnswer = null;
  is("resend answered 500: uncertain, never failed", resent, "uncertain");
  senderAnswer = THROWN;
  is("resend, a thrown request: the same", await resendPreorder(shop, session(1, "ana-pre@example.com") as Parameters<typeof resendPreorder>[1], book, deps), "uncertain");
  senderAnswer = REFUSED;
  is("resend, a 422: failed, as before (control)", await resendPreorder(shop, session(1, "ana-pre@example.com") as Parameters<typeof resendPreorder>[1], book, deps), "failed");
  senderAnswer = REFUSED;
  is("confirmation, a 422: failed, as before (control)", await confirmPreorder(shop, session(2, "ben-pre@example.com"), book, deps), "failed");
  senderAnswer = null;
  is("resend, a plain yes: sent (control)", await resendPreorder(shop, session(1, "ana-pre@example.com") as Parameters<typeof resendPreorder>[1], book, deps), "sent");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
