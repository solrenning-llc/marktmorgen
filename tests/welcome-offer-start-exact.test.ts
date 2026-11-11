/**
 * The start of a person's welcome offer is read exactly (CX-123 rule 24;
 * review of #3298 by Claude 2, MEDIUM). welcomeFor
 * (lib/welcome-offer-send.ts) writes the start once with SET NX and reads it
 * back with GET in the same pipeline. The start decides whether the offer
 * has ended, and so whether openWelcome opens a checkout with the welcome
 * coupon. A reply in any other shape than ["OK" or nil, a string of digits]
 * is unknown: no offer is shown, no checkout opens and no reminder is set.
 * It is never read as "the offer began now".
 *
 * Setup: an offer of 48 hours that began for a person 30 days ago; they ask
 * for a free product again now, so the new claim's time is now.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { openWelcome, scheduleReminder, welcomeFor } from "@/lib/welcome-offer-send";
import { readClaimFull, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_start_only_a_stand_in";

const sent: { text: string }[] = [];
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { text: string };
    sent.push({ text: body.text });
    return json({ id: "email_1" });
  }
  if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    checkouts.push(new URLSearchParams(String(init.body)));
    return json({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/welcome-start" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "start-owner@example.com";
const HOUR = 3600;
const DAY = 86_400;

const real = redis.pipeline.bind(redis);
let odd: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (odd !== undefined && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith("nl:wo:start:")) return odd as unknown[];
  return real(commands);
}) as typeof redis.pipeline;

const reported: string[] = [];
const error = console.error;
console.error = (...args: unknown[]) => {
  reported.push(args.map(String).join(" "));
};

async function due(): Promise<number> {
  const [n] = await real([["ZCARD", "nl:wo:due"]]);
  return Number(n ?? 0);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "startkitchen", "Start Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_WelcomeStart1", true);
  await setSubscription(OWNER, { customerId: "cus_WelcomeStart1", subscriptionId: "sub_WelcomeStart1", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, free.product.id))!;

  const EMAIL = "back@example.com";
  const result = await requestCopy({ store, product, email: EMAIL, consent: true, ip: "10.0.1.1", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(sent[0].text)?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  const now = Math.floor(Date.parse(claim.at) / 1000) + 60;
  const began = now - 30 * DAY;
  // The person's offer began 30 days ago, read exactly.
  const first = await welcomeFor(store, { e: EMAIL, p: free.product.id, at: new Date(began * 1000).toISOString() }, began + 60);
  is("setup: the offer began 30 days ago and lasted 48 hours", first?.until, began + 48 * HOUR);

  part("Controls: exact answers");
  checkouts.length = 0;
  const back = await welcomeFor(store, claim, now);
  is("asked again now (nil, the kept start): the offer ended", [back?.until, back?.ended], [began + 48 * HOUR, true]);
  const closed = await openWelcome(store, token, "https://marktmorgen.com", now, TEST_CONSENT);
  is("asked again now: the button opens no checkout, the offer ended", [closed.ok ? "opened" : closed.reason, checkouts.length], ["expired", 0]);
  is("asked again now: no reminder set", [await scheduleReminder(store, claim, token, now), await due()], [false, 0]);
  is("nothing reported for the exact answers", reported.length, 0);

  part("An answer in no known shape for the start: no offer, no checkout, no reminder, reported");
  const BAD: [string, unknown][] = [
    ["not a list", { result: "OK" }],
    ["one reply for two commands", [null]],
    ["no reply", []],
    ["an extra reply", [null, String(began), "OK"]],
    ["GET answered QUEUED", [null, "QUEUED"]],
    ["GET answered nil", [null, null]],
    ["GET answered a number", [null, began]],
    ["GET answered an empty string", [null, ""]],
    ["GET answered zero", [null, "0"]],
    ["GET answered a decimal", [null, `${began}.5`]],
    ["SET answered QUEUED", ["QUEUED", String(began)]],
    ["SET answered lower-case ok", ["ok", String(began)]],
    ["SET answered a number", [1, String(began)]],
  ];
  for (const [label, reply] of BAD) {
    checkouts.length = 0;
    const before = reported.length;
    const queued = await due();
    odd = reply;
    const read = await welcomeFor(store, claim, now).then(
      (offer) => (offer ? `offer, ended ${offer.ended}` : "none"),
      (e: unknown) => (e instanceof UnknownReplyError ? "unknown" : `threw ${String(e)}`),
    );
    const opened = await openWelcome(store, token, "https://marktmorgen.com", now, TEST_CONSENT).catch((e: unknown) => ({ ok: false as const, reason: `threw ${String(e)}` }));
    const reminded = await scheduleReminder(store, claim, token, now).catch(() => false);
    odd = undefined;
    is(`${label}: welcomeFor refuses (UnknownReplyError), never a live offer`, read, "unknown");
    is(`${label}: the button opens no checkout and says unavailable`, [opened.ok ? "opened" : opened.reason, checkouts.length], ["unavailable", 0]);
    is(`${label}: no reminder set`, [reminded, (await due()) - queued], [false, 0]);
    is(`${label}: reported`, reported.length > before, true);
  }

  part("Afterward, exact answers read the same as before");
  checkouts.length = 0;
  const after = await openWelcome(store, token, "https://marktmorgen.com", now, TEST_CONSENT);
  is("the offer still ended: no checkout", [after.ok ? "opened" : after.reason, checkouts.length], ["expired", 0]);

  console.error = error;
  done();
}

void main();
