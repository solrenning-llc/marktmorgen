/**
 * A welcome offer with a deadline of each person's own (lib/welcome-offer.ts,
 * lib/welcome-offer-send.ts; added 13 October 2026). Checked:
 *
 *   - the settings read back whole, and the reminder's time and the countdown
 *     are worked out the same way everywhere;
 *   - the deadline starts when the person asked, and nothing starts it again:
 *     not the page opened later, not a second free product;
 *   - while it lasts, the button opens a checkout with the coupon, for the
 *     address the free copy went to, marked as a welcome offer; after it, no
 *     checkout opens;
 *   - one reminder, only to someone who agreed and confirmed, sent once,
 *     with the link back to their page;
 *   - the numbers count those sales as "Welcome offer".
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { NO_WELCOME_OFFER, endsAt, leftWords, parseWelcomeOffer, remindAt } from "@/lib/welcome-offer";
import { openWelcome, scheduleReminder, sendWelcomeReminders, welcomeFor } from "@/lib/welcome-offer-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { discountKindOf, entryOf } from "@/lib/discount-impact";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";

const sent: { to: string; subject: string; text: string }[] = [];
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: "email_1" });
  }
  if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    checkouts.push(new URLSearchParams(String(init.body)));
    return json({ id: `cs_test_${"w".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/welcome" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const HOUR = 3600;


/** The reply to the first pipeline that writes a key starting with `prefix`, without the write landing (CX-123 rule 24, L9). */
async function withOddWrite<T>(prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function ask(email: string, productId: string, consent: boolean): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, productId))!;
  const before = sent.length;
  const result = await requestCopy({ store, product, email, consent, ip: `10.0.0.${sent.length}`, origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  return /token=([0-9a-f]{64})/.exec(sent[before].text)?.[1] ?? "";
}

async function main(): Promise<void> {
  redis.clear();

  part("The settings and the clock");
  is("off until set, and read back whole", [parseWelcomeOffer(null), parseWelcomeOffer({ product: "guide", percent: 33, hours: 48, coupon: "c_welcome" }).percent, parseWelcomeOffer({ product: "guide", percent: 20, hours: 5, coupon: "c_welcome" }).hours], [NO_WELCOME_OFFER, 0, 48]);
  is("the reminder a quarter of the time before the end, never more than twelve hours", [endsAt(0, 24) - remindAt(0, 24), endsAt(0, 48) - remindAt(0, 48), endsAt(0, 168) - remindAt(0, 168)], [6 * HOUR, 12 * HOUR, 12 * HOUR]);
  is("hours, minutes and seconds left, and nothing once it ends", [leftWords(100 + 47 * HOUR + 59 * 60 + 12, 100), leftWords(100, 100)], ["47:59:12", null]);

  part("A store with a free guide and a paid course");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWelcome001", true);
  await setSubscription(OWNER, { customerId: "cus_Welcome0001", subscriptionId: "sub_Welcome0001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const free2 = await addProduct(OWNER, "Spice Chart", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !free2.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, free2, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });

  part("The deadline starts when they asked, once");
  const token = await ask("lead@example.com", free.product.id, true);
  const claim = (await readClaimFull(token))!;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  let store = (await storeForEmail(OWNER))!;
  const first = await welcomeFor(store, claim, asked + 60);
  is("the course, 25% off, until 48 hours after asking", [first?.product.title, first?.percent, first?.until, first?.ended], ["Knife Skills", 25, asked + 48 * HOUR, false]);
  const later = await welcomeFor(store, claim, asked + 10 * HOUR);
  is("opened again ten hours later: the same end", later?.until, asked + 48 * HOUR);
  const token2 = await ask("lead@example.com", free2.product.id, true);
  const claim2 = { ...(await readClaimFull(token2))!, at: new Date((asked + 20 * HOUR) * 1000).toISOString() };
  is("a second free product a day later: still the same end", (await welcomeFor(store, claim2, asked + 20 * HOUR))?.until, asked + 48 * HOUR);
  is("not offered on the product it is for", await welcomeFor(store, { ...claim, p: paid.product.id }), null);

  part("The button, while it lasts and after");
  checkouts.length = 0;
  const unasked = await openWelcome(store, token, "https://marktmorgen.com", asked + HOUR);
  is("without the box to start before the 14 days end (lib/digital-consent.ts), no checkout opens", unasked.ok ? "opened" : unasked.reason, "consent");
  const opened = await openWelcome(store, token, "https://marktmorgen.com", asked + HOUR, TEST_CONSENT);
  const body = checkouts[0];
  is("a checkout with the coupon, for that address, marked as a welcome offer", [opened.ok, body?.get("discounts[0][coupon]"), body?.get("customer_email"), body?.get("metadata[welcome]"), body?.has("metadata[winback]")], [true, "c_welcome25", "lead@example.com", "yes", false]);
  checkouts.length = 0;
  const ended = await openWelcome(store, token, "https://marktmorgen.com", asked + 48 * HOUR, TEST_CONSENT);
  is("at the end, no checkout opens", [ended.ok ? "" : ended.reason, checkouts.length], ["expired", 0]);
  is("a link for another store opens nothing", (await openWelcome({ ...store, handle: "other" }, token, "https://marktmorgen.com", asked + HOUR)).ok, false);

  part("One reminder, to someone who agreed and confirmed");
  await recordLead(store, claim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  is("set once", [await scheduleReminder(store, claim, token, asked + HOUR), await scheduleReminder(store, claim, token2, asked + 2 * HOUR)], [true, false]);
  const quiet = await ask("quiet@example.com", free.product.id, false);
  is("never for someone who did not agree", await scheduleReminder(store, (await readClaimFull(quiet))!, quiet, asked + HOUR), false);
  const before = sent.length;
  is("not before its time", (await sendWelcomeReminders(Date.now() + 10_000, asked + HOUR)).sent, 0);
  const due = await sendWelcomeReminders(Date.now() + 10_000, remindAt(asked, 48) + 1);
  const mail = sent[sent.length - 1];
  is("sent when due, once, with the link back and the address at the bottom", [due.sent, sent.length - before, mail?.to, /25% off Knife Skills: 12 hours left/.test(mail?.subject ?? ""), mail?.text.includes(`/@harbor/free?token=${token}`), mail?.text.includes("1 Main St")], [1, 1, "lead@example.com", true, true, true]);
  is("and not again", (await sendWelcomeReminders(Date.now() + 10_000, remindAt(asked, 48) + 60)).sent, 0);

  part("In the numbers");
  is("a checkout and a membership marked as a welcome offer count as one", [discountKindOf({ metadata: { welcome: "yes" } }), entryOf({ discount: "welcome" })], ["welcome", "welcome"]);

  part("The once-only reminder mark, read exactly (CX-123 rule 24, L9)");
  // CX-123 rule 24, L9: the once-only mark answered oddly, without landing, schedules nothing; a whole answer later does.
  const odd = await ask("odd@example.com", free.product.id, true);
  await recordLead(store, (await readClaimFull(odd))!, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  const oddClaim = (await readClaimFull(odd))!;
  is("a once-only mark answered oddly that did not land schedules nothing", await withOddWrite("nl:wo:r:", ["QUEUED"], () => scheduleReminder(store, oddClaim, odd, asked + HOUR)), false);
  is("the next whole answer schedules it, once", [await scheduleReminder(store, oddClaim, odd, asked + HOUR), await scheduleReminder(store, oddClaim, odd, asked + HOUR)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
