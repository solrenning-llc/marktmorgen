/**
 * The final pre-review of claude5/switch-price-checked (7e184fcef2), on the whole checkout with a choose-your-price
 * product (lib/pay-what-you-want.ts, lib/store-checkout.ts, lib/stock.ts, app/api/store/checkout/route.ts):
 *
 *   H1  a retry after an archived Price whose count was lost (its INCR never landed while a second retry rode its
 *       mark) went back to a key Stripe answers with that same archived Price, and every checkout failed for 25 hours
 *       without ever reaching price-held;
 *   H2  the same when Stripe still keeps a key's reply after the count ran out;
 *   H3  a reply that says the Price is not active was used as one;
 *   H4  a limited product's unit stayed held for the provisional hold's term when the retry ended held, though
 *       Stripe had refused the only checkout asked for;
 *   H5  price-held told the creator nothing;
 *   H6  the buyer was told the payment company set the price up wrong, false when the creator archived it.
 *
 * This Stripe keeps and replays its reply per Idempotency-Key, as Stripe does (with the reply as first written).
 */
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { PwywPriceHeld, REFUSED_MOST, pwywPriceId } from "@/lib/pay-what-you-want";
import { stockLeft, withStockHold } from "@/lib/stock";
import { readTrouble } from "@/lib/checkout-trouble";
import { checkoutCheck } from "@/lib/checkup-rules";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_pwyw_held_truth";
process.env.RESEND_API_KEY = "re_test_pwyw_held_truth_only";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const kept = new Map<string, Record<string, unknown>>();
const archived = new Set<string>();
const emails: { to: string; subject: string; text: string }[] = [];
let made = 0;
let sessionsMade = 0;
let inactive = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (method === "POST" && path === "/prices") {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
    made++;
    const reply = { ...priceEcho(`price_Made${String(made).padStart(8, "0")}`, body), ...(inactive ? { active: false } : {}) };
    if (key) kept.set(key, reply);
    return new Response(JSON.stringify(reply));
  }
  if (method === "POST" && path === "/checkout/sessions") {
    const price = body.get("line_items[0][price]") ?? "";
    if (archived.has(price)) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "The price specified is inactive. This field only accepts active prices." } }), { status: 400 });
    sessionsMade++;
    const id = `cs_test_${String(sessionsMade).padStart(24, "0")}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open" }));
  }
  const one = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
  if (one && method === "GET") return new Response(JSON.stringify({ id: one[1], status: "open" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Bread Book", "", "5", null, "9");
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/bread");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, added.product.id))!;
  is("the product is sold at a price the buyer chooses", product.pwyw, { suggestedCents: 900 });
  let lastPrice = "";
  const buy = async () => {
    const before = sessionsMade;
    try {
      await createCheckout(store, product, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
      return sessionsMade > before ? lastPrice : "none";
    } catch (e) {
      return e instanceof PwywPriceHeld ? "held" : `error:${(e as Error).message.slice(0, 60)}`;
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") lastPrice = new URLSearchParams(String(init?.body ?? "")).get("line_items[0][price]") ?? "";
    return realFetch(input, init);
  }) as typeof fetch;
  /** The store stays; only the choose-your-price keys go, so the product starts again with no Price, and Stripe forgets. */
  const forget = async () => {
    for (const name of redis.keys().filter((k) => k.startsWith("nl:pwyw:"))) await redis.pipeline([["DEL", name]]);
    kept.clear(); archived.clear(); made = 0;
  };
  const countOf = async () => (await redis.pipeline([["GET", redis.keys().find((k) => k.endsWith(":refused")) ?? "none"]]))[0];

  part("H1: a count lost while a second retry rode the mark: the key Stripe answers with the archived Price is left");
  const p1 = await buy();
  is("the first Price is made and used", [p1, made], ["price_Made00000001", 1]);
  archived.add(p1);
  const real = redis.pipeline.bind(redis);
  let releaseIncr: () => void = () => {};
  let failOnce = true;
  (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
    if (failOnce && commands.some((c) => c[0] === "INCR")) {
      failOnce = false;
      await new Promise<void>((r) => { releaseIncr = r; });
      throw new Error("INCR lost");
    }
    return real(commands);
  };
  const a = pwywPriceId(store, product, product.pwyw!, p1).catch((e) => `error:${(e as Error).message}`);
  await new Promise((r) => setTimeout(r, 5));
  const b = await pwywPriceId(store, product, product.pwyw!, p1).catch((e) => `error:${(e as Error).message}`);
  releaseIncr();
  is("A fails, B made P2 under the retry's key while the count stayed 0", [(await a).startsWith("error:"), b, await countOf()], [true, "price_Made00000002", null]);
  (redis as unknown as { pipeline: typeof real }).pipeline = real;
  archived.add(b);
  const h1: string[] = [];
  for (let i = 0; i < 3; i++) h1.push(await buy());
  // Before: every one failed on the replayed archived P2, never price-held, for the 25 hours of the mark.
  is("the replayed archived Price is a refusal: one checkout fails, the next opens on a new Price, kept",
    [h1[0].startsWith("error:"), h1[1].startsWith("price_Made") && h1[1] !== b, h1[2] === h1[1], made], [true, true, true, 3]);

  part("H2: Stripe still keeps a key's reply after the count ran out");
  await forget();
  const q1 = await buy();
  archived.add(q1);
  const q2 = await buy();
  is("an archived Price is made again under the retry's key", [q2 !== q1 && q2.startsWith("price_Made"), made], [true, 2]);
  redis.advance(25 * 60 * 60 * 1000 + 1000); // the count and the marks run out; Stripe has not pruned its keys yet
  archived.add(q2);
  const h2: string[] = [];
  for (let i = 0; i < 3; i++) h2.push(await buy());
  is("one checkout fails on the replay, then a new Price opens and is kept", [h2[0].startsWith("error:"), h2[1].startsWith("price_Made") && h2[1] !== q2, h2[2] === h2[1], made], [true, true, true, 3]);

  part("H3: a reply that says the Price is not active is never used, nor kept");
  await forget();
  inactive = true;
  const h3 = await pwywPriceId(store, product, product.pwyw!).catch((e) => (e instanceof PwywPriceHeld ? "held" : "error"));
  inactive = false;
  const after3 = await pwywPriceId(store, product, product.pwyw!).catch(() => "error");
  is("refused, then asked again under a new key and the active one used", [h3, after3, made], ["error", "price_Made00000002", 2]);

  part("H4: a limited product's unit is handed back when the retry ends held after Stripe refused the only checkout");
  await forget();
  const limited = { ...product, stock: 5 };
  const hold = (p: typeof limited) => withStockHold(store, p, (held) => createCheckout(store, p, "https://marktmorgen.com", "", { held, digitalConsent: TEST_CONSENT }))
    .then((r) => (r.ok ? "opened" : r.reason), (e: Error) => (e instanceof PwywPriceHeld ? "held" : `error:${e.message.slice(0, 40)}`));
  is("the first opens on a new Price and holds a unit", [await hold(limited), await stockLeft(store, limited)], ["opened", 4]);
  const first = lastPrice;
  // The count already at REFUSED_MOST: the retry after the archived Price is held before it asks Stripe anything.
  await redis.pipeline([["SET", redis.keys().find((k) => k.endsWith(":checked"))!.replace(/:checked$/, ":refused"), String(REFUSED_MOST), "EX", 3600]]);
  archived.add(first);
  is("held: Stripe refused the kept Price and no other checkout was asked for", await hold(limited), "held");
  is("and its unit is handed back at once", await stockLeft(store, limited), 4);

  part("H5: the creator is told when a product is held (app/api/store/checkout/route.ts)");
  await forget();
  emails.length = 0;
  const post = () => {
    const f = new FormData();
    f.set("handle", "harbor");
    f.set("product", product.id);
    return checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
  };
  is("the first checkout opens", (await post()).headers.get("location")?.startsWith("https://checkout.stripe.com/"), true);
  await redis.pipeline([["SET", redis.keys().find((k) => k.endsWith(":checked"))!.replace(/:checked$/, ":refused"), String(REFUSED_MOST), "EX", 3600]]);
  archived.add(lastPrice);
  const tasks = afterTasks.length;
  is("the buyer is sent back with price-held", (await post()).headers.get("location"), "https://marktmorgen.com/@harbor?status=price-held");
  is("a note for the creator is left for after the answer", afterTasks.length - tasks, 1);
  for (const task of afterTasks.splice(tasks)) await (task as () => Promise<unknown>)();
  const trouble = await readTrouble(store.statsId);
  is("counted in the studio's checkout refusals, in our words, never as Stripe's", [trouble.week, trouble.last?.code], [1, "pwyw_price_held"]);
  is("the creator is emailed once, about this product, with nothing about the buyer",
    [emails.length, emails[0]?.to, /Bread Book/.test(emails[0]?.text ?? ""), /in its own words/.test(emails[0]?.text ?? ""), /25 hours/.test(emails[0]?.text ?? "")], [1, OWNER, true, false, true]);
  const shown = checkoutCheck(trouble);
  is("the studio's checkup never puts our words in Stripe's mouth, and says what helps",
    [shown.state, /Stripe would not open|Stripe said|it said/.test(shown.found), shown.found.includes(trouble.last?.message ?? "-"), /active/.test(shown.fix && "where" in shown.fix ? String(shown.fix.where) : "")], ["problem", false, true, true]);

  part("H6: what the buyer of a held product reads is true whoever caused it, and blames no one");
  const old = [
    "Nothing was charged. The payment company did not set up the price you choose correctly. Try again tomorrow.",
    "Es wurde nichts berechnet. Der Zahlungsdienst hat den Preis, den Sie wählen, nicht richtig eingerichtet. Versuchen Sie es morgen noch einmal.",
    "No se ha cobrado nada. La empresa de pagos no configuró bien el precio que eliges. Vuelve a intentarlo mañana.",
    "Er is niets afgeschreven. De betaaldienst heeft de prijs die je kiest niet goed klaargezet. Probeer het morgen opnieuw.",
    "Non è stato addebitato nulla. Il servizio di pagamento non ha preparato bene il prezzo che scegli. Riprova domani.",
    "Rien n'a été débité. Le service de paiement n'a pas bien préparé le prix que vous choisissez. Réessayez demain.",
    "Nada foi cobrado. O serviço de pagamento não preparou corretamente o preço que escolhe. Tente novamente amanhã.",
  ];
  is("no language still says the payment company set it up wrong", LANGUAGE_CODES.filter((code) => old.includes(wordsIn(code).notices["price-held"]?.body ?? "")), []);
  is("every language says how long it is paused", LANGUAGE_CODES.filter((code) => !/\b25\b/.test(wordsIn(code).notices["price-held"]?.body ?? "")), []);
  is("in plain US English", wordsIn("en").notices["price-held"], {
    title: "This product can't be bought right now",
    body: "Nothing was charged. Buying it is paused for up to 25 hours, because its price had to be set up again too many times. Please try again later.",
  });
}

main().then(done);
