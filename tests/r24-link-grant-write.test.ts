/**
 * A link's grant, written before the link is emailed or handed out, read in
 * its exact shape (CX-123 rule 24).
 *
 * Four places wrote a link's grant with one SET and never read its reply:
 * lib/buyer-library.ts requestLibraryLink, lib/buyer-orders.ts sendLink (run
 * after requestOrdersLink answers) and ordersLinkFor, and
 * lib/recovery-address.ts sendLostEmailLink. When the write did not land,
 * the person was sent (or handed) a link that does not open, and for three
 * of them a metered email was spent on it. lib/recovery-address.ts
 * startRecoveryAddress emailed a code before writing it, unread: a write
 * that did not land sent a code that can never be confirmed.
 *
 * Here each is called as its caller calls it, on the in-memory store, with
 * only that SET answered in another shape: the reply missing, the pipeline
 * itself missing or cut short, "QUEUED", a number, or Redis throwing. What
 * is checked: only exactly "OK" lets an email go out or a link be handed
 * out; otherwise no email goes, no store email allowance is taken, and the
 * caller answers as it should (the library form "error"; the orders form
 * "sent" with the failure in the log; ordersLinkFor null, so a purchase
 * email still goes with the generic orders link; the lost-inbox form "sent"
 * with neither the link nor the notice sent).
 */
import { NextRequest } from "next/server";
import { rememberBuyers, requestLibraryLink } from "@/lib/buyer-library";
import { ordersLinkFor, requestOrdersLink } from "@/lib/buyer-orders";
import { confirmRecoveryAddress, keepRecoveryAddress, sendLostEmailLink, startRecoveryAddress } from "@/lib/recovery-address";
import { deliverPayPal } from "@/lib/paypal-sales";
import { readListings } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { POST as libraryRoute } from "@/app/api/library/route";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { afterTasks } from "./next-server-after-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fallback fixture already knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_link_grant_only_a_stand_in";

const ORIGIN = "https://marktmorgen.com";

/** Every email handed to the sender. */
const mails: { to: string; text: string }[] = [];
/** The checkouts the stand-in Stripe lists, for any address. */
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: [body.to ?? ""].flat()[0] ?? "", text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname === "api.stripe.com" && path === "/checkout/sessions" && (init?.method ?? "GET") === "GET") {
    return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** Redis throwing for the SET, as a network error or an error reply does. */
const THROWN = Symbol("thrown");
/** The one SET answered differently: its key's start, and what the pipeline answers instead. */
let odd: { prefix: string; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const first = commands[0];
  if (odd && commands.length === 1 && first?.[0] === "SET" && String(first[1]).startsWith(odd.prefix)) {
    if (odd.reply === THROWN) throw new Error("synthetic Redis error for a link's grant");
    return odd.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** What the server logged while it was captured. */
const logged: string[] = [];
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
  consoleError(...args);
};

/** Every reply shape other than exactly ["OK"]. */
const SHAPES: [string, unknown][] = [
  ["the reply missing (null)", [null]],
  ["the pipeline itself missing (null)", null],
  ["a short pipeline ([])", []],
  ["QUEUED", ["QUEUED"]],
  ["a number (1)", [1]],
  ["Redis throwing", THROWN],
];

/** What a call answered, or "unknown" when it threw UnknownReplyError, or "threw" for any other error. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "unknown" | "threw"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  }
}

/** The answer a function gives for a shape after the fix: UnknownReplyError, or Redis's own error when it threw. */
const failed = (reply: unknown) => (reply === THROWN ? "threw" : "unknown");

/** Forgets the hourly request limits, so each shape is asked fresh. */
async function clearLimits(): Promise<void> {
  const keys = redis.keys().filter((key) => key.startsWith("nl:rl:"));
  if (keys.length) await pipeline(keys.map((key) => ["DEL", key]));
}

const post = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.50" }, body: new URLSearchParams(fields) });

async function main(): Promise<void> {
  redis.clear();

  part("requestLibraryLink: the library link's grant");
  {
    const A = "alpha.owner@example.com";
    await claimHandle(A, "alpha", "Alpha", "");
    await ensureStoreId(A);
    const alpha = (await storeForEmail(A)) as Store;
    const buyers = ["control", ...SHAPES.map((_, i) => `s${i}`)].map((name) => `lib.${name}@example.com`);
    await rememberBuyers(alpha.sid, buyers);
    const used = () => allowanceUsed(alpha, "transactional");
    const ask = async (email: string) => {
      await clearLimits();
      return outcome(() => requestLibraryLink({ email, ip: "203.0.113.1", origin: ORIGIN }));
    };
    const viaRoute = async (email: string) => {
      await clearLimits();
      const answer = await libraryRoute(post(`${ORIGIN}/api/library`, { email }));
      return answer.headers.get("location");
    };

    const [m0, q0] = [mails.length, await used()];
    const got = await ask(buyers[0]);
    const link = /\/library\?token=([0-9a-f]{64})/.test(mails.at(-1)?.text ?? "");
    is("\"OK\": the link is emailed, and one store email is taken", [got, mails.length - m0, (await used()) - q0, link], ["sent", 1, 1, true]);
    is("\"OK\" through the route: sent", await viaRoute(buyers[0]), `${ORIGIN}/library?status=sent`);

    for (const [i, [what, reply]] of SHAPES.entries()) {
      const email = buyers[i + 1];
      const [m, q] = [mails.length, await used()];
      odd = { prefix: "nl:lib:link:", reply };
      const answer = await ask(email);
      const page = await viaRoute(email);
      odd = null;
      is(`${what}: fails closed, no email, no store email taken`, [answer, mails.length - m, (await used()) - q], [failed(reply), 0, 0]);
      is(`${what}: the library form answers error`, page, `${ORIGIN}/library?status=error`);
    }
  }

  // A store with a paid plan, a Stripe account and one product, as tests/orders-open.test.ts sets one up.
  const OWNER = "moss.owner@example.com";
  await claimHandle(OWNER, "moss", "Moss Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMoss000001", true);
  await setSubscription(OWNER, { customerId: "cus_moss000001", subscriptionId: "sub_moss000001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Field notes", "", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/notes");
  const moss = (await storeForEmail(OWNER)) as Store;
  const base = `${ORIGIN}/@moss`;
  const bought = (email: string, n: number) => [{
    id: `cs_test_${String(n).padStart(24, "m")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000) - 60,
    customer: "cus_buyer00001",
    metadata: { store: "moss", product: made.product.id },
    customer_details: { email },
    payment_intent: { id: `pi_testmoss${String(n).padStart(6, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }];
  const mossUsed = () => allowanceUsed(moss, "transactional");

  part("sendLink: the purchases link's grant, written after requestOrdersLink answers");
  {
    const ask = async (email: string, n: number) => {
      await clearLimits();
      sessions = bought(email, n);
      afterTasks.length = 0;
      const answer = await requestOrdersLink({ store: moss, email, ip: `198.51.100.${n}`, origin: ORIGIN });
      // What the route's after() runs once the answer is sent (lib/buyer-orders.ts afterAnswer).
      for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
      return answer;
    };
    const [m0, q0] = [mails.length, await mossUsed()];
    const answer = await ask("orders.control@example.com", 1);
    const link = mails.at(-1)?.text.includes(`${base}/orders?token=`) ?? false;
    is("\"OK\": sent, the link is emailed, and one store email is taken", [answer, mails.length - m0, (await mossUsed()) - q0, link], ["sent", 1, 1, true]);

    for (const [i, [what, reply]] of SHAPES.entries()) {
      const email = `orders.s${i}@example.com`;
      const [m, q, l] = [mails.length, await mossUsed(), logged.length];
      odd = { prefix: "nl:orders:link:", reply };
      const got = await ask(email, i + 2);
      odd = null;
      const said = logged.slice(l).some((line) => line.includes("sending a purchases link failed"));
      is(`${what}: still answers sent, no email, no store email taken, the failure logged`, [got, mails.length - m, (await mossUsed()) - q, said], ["sent", 0, 0, true]);
    }
  }

  part("ordersLinkFor: a link handed out without asking");
  {
    const control = await outcome(() => ordersLinkFor(moss, "given.control@example.com", base));
    is("\"OK\": a link with its token", typeof control === "string" && control.startsWith(`${base}/orders?token=`), true);
    for (const [what, reply] of SHAPES) {
      odd = { prefix: "nl:orders:link:", reply };
      const got = await outcome(() => ordersLinkFor(moss, "given@example.com", base));
      odd = null;
      is(`${what}: null, never a link whose grant is unconfirmed`, got, null);
    }
  }

  part("A PayPal purchase's email (lib/paypal-sales.ts deliverPayPal), whose link comes from ordersLinkFor");
  {
    const [product] = await readListings(moss, [made.product.id]);
    const deliver = async (email: string, order: string) => {
      const before = mails.length;
      const done = await outcome(() =>
        deliverPayPal({
          store: moss,
          paid: { store: moss.sid, order, capture: `CAP${order}`, email, product: made.product.id, cents: 1900, currency: "usd", at: Math.floor(Date.now() / 1000) },
          product,
          base,
          from: "Moss Notes <hello@marktmorgen.com>",
          recordStart: async () => {},
          ordersLink: (address) => ordersLinkFor(moss, address, base),
        }),
      );
      const mail = mails.slice(before).find((m) => m.to === email);
      return { done, mail };
    };
    const control = await deliver("paypal.control@example.com", "PPCONTROL0001");
    is("\"OK\": the purchase email carries the link with its token", [control.done, control.mail?.text.includes(`${base}/orders?token=`)], [undefined, true]);
    for (const [i, [what, reply]] of SHAPES.entries()) {
      const email = `paypal.s${i}@example.com`;
      odd = { prefix: "nl:orders:link:", reply };
      const { done: finished, mail } = await deliver(email, `PPSHAPE000${i}`);
      odd = null;
      is(`${what}: the purchase email still goes, with the generic orders link and no token`, [finished, Boolean(mail), mail?.text.includes(`${base}/orders`), mail?.text.includes("token=")], [undefined, true, true, false]);
    }
  }

  part("sendLostEmailLink: a login link to the recovery address");
  {
    const ME = "lost.maker@example.com";
    const SPARE = "lost.spare@example.org";
    await keepRecoveryAddress(ME, SPARE);
    const ask = async () => {
      await clearLimits();
      return outcome(() => sendLostEmailLink(ME, "203.0.113.7", ORIGIN));
    };
    const viaRoute = async () => {
      await clearLimits();
      const answer = await lostRoute(post(`${ORIGIN}/api/auth/lost`, { email: ME }));
      return answer.headers.get("location");
    };
    const m0 = mails.length;
    const got = await ask();
    const sentTo = mails.slice(m0).map((m) => m.to).sort();
    is("\"OK\": the link goes to the recovery address and the sign-in address is told", [got, sentTo], [undefined, [ME, SPARE].sort()]);
    is("\"OK\" through the route: sent", await viaRoute(), `${ORIGIN}/signin/lost?status=sent`);

    for (const [what, reply] of SHAPES) {
      const m = mails.length;
      odd = { prefix: "nl:auth:rec:link:", reply };
      const answer = await ask();
      const page = await viaRoute();
      odd = null;
      is(`${what}: fails closed, neither the link nor the notice is sent`, [answer, mails.length - m], [failed(reply), 0]);
      is(`${what}: the lost-inbox form still answers sent, telling nothing`, page, `${ORIGIN}/signin/lost?status=sent`);
    }
  }

  part("startRecoveryAddress: the pending code is written before the code is emailed");
  {
    // Claude 6's review of #3283: the code went out first and its SET was never read, so a write that did not land
    // emailed a code that could never be confirmed ("expired"), and spent the email on it.
    const ME = "rec.start@example.com";
    const SESSION = "e".repeat(64);
    const ask = async (address: string) => {
      await clearLimits();
      return outcome(() => startRecoveryAddress(ME, SESSION, address));
    };
    const m0 = mails.length;
    const got = await ask("rec.control@example.org");
    const code = /Your code: (\d{6})/.exec(mails.at(-1)?.text ?? "")?.[1] ?? "";
    is("\"OK\": the code is sent to the new address", [got, mails.length - m0, mails.at(-1)?.to], ["sent", 1, "rec.control@example.org"]);
    is("\"OK\": and that code confirms it", await confirmRecoveryAddress(ME, SESSION, code), { address: "rec.control@example.org" });

    for (const [what, reply] of SHAPES) {
      const m = mails.length;
      odd = { prefix: "nl:auth:rec:set:", reply };
      const answer = await ask(`rec.${what.length}@example.org`);
      odd = null;
      is(`${what}: no code is emailed, and the form is told it was not sent`, [answer, mails.length - m], [reply === THROWN ? "threw" : "unsent", 0]);
    }
  }

  done();
}

main().catch((error) => {
  consoleError(error);
  process.exitCode = 1;
});
