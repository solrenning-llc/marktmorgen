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
import { forgetWelcomePerson, openWelcome, scheduleReminder, sendWelcomeReminders, welcomeFor } from "@/lib/welcome-offer-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { discountKindOf, entryOf } from "@/lib/discount-impact";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";

const sent: { to: string; subject: string; text: string }[] = [];
const checkouts: URLSearchParams[] = [];
/** The email service answering with an error, as it may for a moment: 0 when it takes the email. */
let mailDown = 0;
/** Run inside the email service's answer, before it answers: what happens while a send is in flight. */
let duringSend: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    if (duringSend) {
      const run = duringSend;
      duringSend = null;
      await run();
    }
    if (mailDown) return new Response("unavailable", { status: mailDown });
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

  part("A reminder whose send failed before the email service was asked is tried again at its own hour, a few times at the most, never twice");
  const waitingFor = async (email: string) => {
    const [flat] = await redis.pipeline([["ZRANGEBYSCORE", "nl:wo:due", "-inf", "+inf", "WITHSCORES"]]);
    const list = (flat as string[]) ?? [];
    const out: { a: unknown; score: number }[] = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      const v = JSON.parse(list[i]) as { e?: string; a?: unknown };
      if (v.e === email) out.push({ a: v.a, score: Number(list[i + 1]) });
    }
    return out;
  };
  const scheduled = async (email: string) => {
    const t = await ask(email, free.product.id, true);
    const c = (await readClaimFull(t))!;
    await recordLead(store, c, "Pantry Guide");
    store = (await storeForEmail(OWNER))!;
    const began = Math.floor(Date.parse(c.at) / 1000);
    if (!(await scheduleReminder(store, c, t, began + HOUR))) throw new Error(`not scheduled for ${email}`);
    return remindAt(began, 48);
  };
  // The reminders only, not the free copy each person asked for first.
  const to = (email: string) => sent.filter((m) => m.to === email && /hours? left/.test(m.subject)).length;
  /** The free copy's record cannot be read during `run` (a Redis error): a failure before the email service is asked. */
  const claimDown = async <T>(run: () => Promise<T>, during: (() => Promise<void>) | null = null): Promise<T> => {
    const real = redis.pipeline.bind(redis);
    let hook = during;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "GET" && String(commands[0]?.[1] ?? "").startsWith("nl:free:claim:")) {
        if (hook) {
          const now = hook;
          hook = null;
          await now();
        }
        throw new Error("synthetic: the free copy's record could not be read just now");
      }
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      return await run();
    } finally {
      redis.pipeline = real;
    }
  };
  const retryAt = await scheduled("retry@example.com");
  const failedRun = await claimDown(() => sendWelcomeReminders(Date.now() + 10_000, retryAt + 1));
  const back = await waitingFor("retry@example.com");
  is("a read failed before the send: not sent, and back in the queue once, tried once", [failedRun.sent, to("retry@example.com"), back.length, back[0]?.a], [0, 0, 1, 1]);
  is("at its own hour, where an erasure looks for it", back[0]?.score, retryAt);
  const nextRun = await sendWelcomeReminders(Date.now() + 10_000, retryAt + 301);
  is("sent the next time, once", [nextRun.sent >= 1, to("retry@example.com"), (await waitingFor("retry@example.com")).length], [true, 1, 0]);
  await sendWelcomeReminders(Date.now() + 10_000, retryAt + 601);
  is("and not again", to("retry@example.com"), 1);

  const downAt = await scheduled("down@example.com");
  const triedAs: unknown[] = [];
  for (let run = 0; run < 5; run += 1) {
    await claimDown(() => sendWelcomeReminders(Date.now() + 10_000, downAt + 1 + run * 300));
    triedAs.push((await waitingFor("down@example.com"))[0]?.a ?? null);
  }
  is("still failing: tried again three times, then dropped, never sent", [triedAs, to("down@example.com")], [[1, 2, 3, null, null], 0]);

  // Claude 2 on #3214: the email service's answer cannot tell a refusal (a 4xx, an address it will never take, an
  // uncertain SES answer) from a failure that may pass, and each ask takes the store's email room again. So a reminder
  // the email service was asked for is never tried again.
  const refusedAt = await scheduled("refused@example.com");
  const roomBefore = await allowanceUsed(store, "email");
  is("the store's email room is read", roomBefore > 0, true);
  mailDown = 400;
  const refusedRun = await sendWelcomeReminders(Date.now() + 10_000, refusedAt + 1);
  mailDown = 0;
  is("the email service said no: not sent, not put back", [refusedRun.sent, to("refused@example.com"), (await waitingFor("refused@example.com")).length], [0, 0, 0]);
  is("its room taken once, for the one ask", (await allowanceUsed(store, "email")) - roomBefore, 1);
  for (let run = 1; run < 5; run += 1) await sendWelcomeReminders(Date.now() + 10_000, refusedAt + 1 + run * 300);
  is("no later run sends it or takes more of the store's email room", [to("refused@example.com"), (await allowanceUsed(store, "email")) - roomBefore], [0, 1]);

  // An answer that may have been taken (a server error) is never sent a second time.
  const maybeAt = await scheduled("maybe@example.com");
  mailDown = 503;
  await sendWelcomeReminders(Date.now() + 10_000, maybeAt + 1);
  mailDown = 0;
  for (let run = 1; run < 5; run += 1) await sendWelcomeReminders(Date.now() + 10_000, maybeAt + 1 + run * 300);
  is("a send that may have gone through is never sent again", [to("maybe@example.com"), (await waitingFor("maybe@example.com")).length], [0, 0]);

  const goneAt = await scheduled("gone@example.com");
  await claimDown(() => sendWelcomeReminders(Date.now() + 10_000, goneAt + 1));
  is("waiting again after a failed send", (await waitingFor("gone@example.com")).length, 1);
  const erased = await forgetWelcomePerson(store.statsId, "gone@example.com");
  is("erasing the person takes it out of the queue with their marks", [erased >= 2, (await waitingFor("gone@example.com")).length], [true, 0]);
  await sendWelcomeReminders(Date.now() + 10_000, goneAt + 301);
  is("and nothing is sent to them", to("gone@example.com"), 0);

  // Claude 3 on #3214: the person is erased while their reminder is off the queue, and the try then fails. The erasure
  // finds nothing there and says it erased; the put-back must not bring the person's address back into the queue.
  const raceAt = await scheduled("race@example.com");
  let erasedDuring = -1;
  await claimDown(
    () => sendWelcomeReminders(Date.now() + 10_000, raceAt + 1),
    async () => {
      erasedDuring = await forgetWelcomePerson(store.statsId, "race@example.com");
    },
  );
  is("the erasure ran during the try and said it erased", erasedDuring >= 1, true);
  is("after the erasure answered, no reminder holding their address waits in the queue", (await waitingFor("race@example.com")).length, 0);
  await sendWelcomeReminders(Date.now() + 10_000, raceAt + 301);
  is("and nothing is sent to them after", to("race@example.com"), 0);

  // The same while the email service is asked, and it says no: never put back either.
  const sendRaceAt = await scheduled("sendrace@example.com");
  let erasedInSend = -1;
  duringSend = async () => {
    erasedInSend = await forgetWelcomePerson(store.statsId, "sendrace@example.com");
  };
  mailDown = 400;
  await sendWelcomeReminders(Date.now() + 10_000, sendRaceAt + 1);
  mailDown = 0;
  duringSend = null;
  is("erased during a refused send: nothing waits, nothing is sent after", [erasedInSend >= 1, (await waitingFor("sendrace@example.com")).length], [true, 0]);
  await sendWelcomeReminders(Date.now() + 10_000, sendRaceAt + 301);
  is("and nothing is sent to them after the refused send", to("sendrace@example.com"), 0);

  part("The queue's read, in its exact shape (CX-123 rule 24)");
  const realPipeline = redis.pipeline.bind(redis);
  const oddRead = async (reply: unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "ZRANGEBYSCORE" && commands[0]?.[1] === "nl:wo:due" ? reply : realPipeline(commands)) as typeof redis.pipeline;
    try {
      await sendWelcomeReminders(Date.now() + 10_000, goneAt + 900);
      return "read";
    } catch (error) {
      return error instanceof Error ? error.name : "thrown";
    } finally {
      redis.pipeline = realPipeline;
    }
  };
  is(
    "a member without its hour, an hour of no known shape, or no list: unknown, never \"nothing due\"",
    [await oddRead([["{}"]]), await oddRead([["{}", "soon"]]), await oddRead([null]), await oddRead([])],
    ["UnknownReplyError", "UnknownReplyError", "UnknownReplyError", "UnknownReplyError"],
  );
  is("an empty queue is read as nothing due", await oddRead([[]]), "read");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
