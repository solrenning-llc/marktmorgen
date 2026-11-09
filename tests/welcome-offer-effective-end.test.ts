/**
 * The welcome offer and the come-back offer end, for the buyer, at one
 * instant: the last moment a discounted checkout can still be opened and
 * close by the offer's own end (pre-review of claude5/welcome-offer-deadline,
 * 9 November 2026). Every discounted checkout closes CHECKOUT_OPEN_SECONDS
 * after it is made (lib/stripe-account.ts), so the button stops opening one
 * that long before the end; until this, the page, its countdown, the
 * reminder and the come-back email still promised the full end, and in its
 * last 31 minutes the page showed the offer and a button that answered
 * "this offer has ended". Checked, with the clock played by the test:
 *
 *   - the welcome page reads the effective end: it shows "ended" exactly
 *     when the button refuses, and its countdown and its "until" name that
 *     instant;
 *   - the one reminder is sent the same time before that instant and names it;
 *   - the come-back page reads the same effective end from the link, and the
 *     come-back email names that day and hour, never a later one;
 *   - a discounted checkout made but not handed over, because its end came
 *     while Stripe made it, is closed at Stripe;
 *   - a discounted checkout never carries Stripe's recovery link, whose copy
 *     would carry the discount past the person's end.
 *
 * Stripe and the sender are played by a stand-in for `fetch`; ids are synthetic.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { openWelcome, scheduleReminder, sendWelcomeReminders, welcomeFor } from "@/lib/welcome-offer-send";
import { openWinBack, readWinBack, sendWinBacks } from "@/lib/winback-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { upsertContact } from "@/lib/contacts";
import { OFFER_DAYS } from "@/lib/winback";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, setWelcomeOffer, setWinBack, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { readFileSync } from "node:fs";
import { CHECKOUT_OPEN_SECONDS } from "@/lib/stripe-account";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_end_only_a_stand_in";

const HOUR = 3600;
const DAY = 86_400;
/** How long a discounted checkout stays open once made (lib/stripe-account.ts, CHECKOUT_OPEN_SECONDS). */
const OPEN = 31 * 60;

// The test's clock: Date.now and the Redis stand-in's expiry both read it.
let clock = Date.now();
Date.now = () => clock;
/** Seconds the clock moves while Stripe makes a checkout, for a slow request. */
let slowBy = 0;

const mails: { to: string; subject: string; text: string }[] = [];
const checkouts: URLSearchParams[] = [];
const expired: string[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    mails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && init?.method === "POST") {
    checkouts.push(new URLSearchParams(String(init.body)));
    clock += slowBy * 1000;
    return json({ id: `cs_test_${"e".repeat(22)}${String(checkouts.length).padStart(2, "0")}`, url: "https://checkout.stripe.com/c/pay/end" });
  }
  if (/^\/checkout\/sessions\/cs_[^/]+\/expire$/.test(path) && init?.method === "POST") {
    expired.push(path);
    return json({ status: "expired" });
  }
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return json({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return json({ id: customer[1], email: customers.get(customer[1]) ?? null });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const at = (seconds: number) => {
  clock = seconds * 1000;
  return seconds;
};
/** "November 9, 2026 at 3:12 PM UTC": a day and an hour as the English store writes them. */
const moment = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestEffectEnd1", true);
  await setSubscription(OWNER, { customerId: "cus_EffectEnd0001", subscriptionId: "sub_EffectEnd0001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  const club = await addProduct(OWNER, "Supper Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!free.ok || !paid.ok || !club.ok) throw new Error("no products");
  for (const p of [free, paid, club]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 24, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  await setWinBack(OWNER, { percent: 25, months: 1, days: 7, coupon: "co_Back0001", address: "1 Main St, Springfield, IL 62701" });
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, free.product.id))!;
  const result = await requestCopy({ store, product, email: "lead@example.com", consent: true, ip: "10.0.0.1", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(mails[0]?.text ?? "")?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const until = asked + 24 * HOUR;
  const end = until - OPEN;
  const welcome = async (now: number) => {
    checkouts.length = 0;
    const here = await welcomeFor(store, claim, at(now));
    const opened = await openWelcome(store, token, "https://marktmorgen.com", now, TEST_CONSENT);
    return { ended: here?.ended, until: here?.until, opened: opened.ok ? "opened" : opened.reason, tries: checkouts.length };
  };

  part("Welcome offer: the page reads the effective end");
  let seen = await welcome(asked + HOUR);
  is("its until (the countdown and the words beside it) is the last moment the button opens", seen.until, end);
  is("control: an hour in, it opens", seen.opened, "opened");

  part("Welcome offer: the page and the button agree at every moment");
  for (const left of [OPEN + 60, OPEN + 1, OPEN, 20 * 60, 60]) {
    seen = await welcome(until - left);
    is(`${left} s before the full end: "ended" shown exactly when the button refuses`, seen.ended === true, seen.opened !== "opened");
  }
  seen = await welcome(end - 1);
  is("one second before the effective end: shown, and opens", [seen.ended, seen.opened], [false, "opened"]);
  seen = await welcome(end);
  is("at the effective end: shown ended, and no discounted checkout", [seen.ended, seen.opened, seen.tries], [true, "expired", 0]);

  part("Welcome offer: the reminder names the effective end, the same time before it");
  await recordLead(store, claim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  is("control: scheduled once", await scheduleReminder(store, claim, token, at(asked + HOUR)), true);
  const due = end - 6 * HOUR;
  const before = mails.length;
  at(due);
  is("sent a quarter of the time before the effective end", (await sendWelcomeReminders(Date.now() + 10_000, due)).sent, 1);
  const reminder = mails[before];
  is("its subject says the hours there are", /: 6 hours left/.test(reminder?.subject ?? ""), true);
  is("its words name the effective end", reminder?.text.includes(moment(end)), true);
  is("never the full end, which the button does not keep", reminder?.text.includes(moment(until)), false);

  part("A discounted checkout made but not handed over is closed at Stripe");
  slowBy = 5 * 60;
  expired.length = 0;
  seen = await welcome(until - 32 * 60);
  slowBy = 0;
  is("control: made once, not handed over", [seen.tries, seen.opened], [1, "expired"]);
  is("the welcome checkout just made is closed (POST .../expire)", expired.length, 1);

  part("Come-back link: the page reads the effective end");
  const now = asked + 2 * HOUR;
  const grant = async (seconds: number) => {
    at(now);
    const back = Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    await redis.pipeline([["SET", `nl:wb:link:${back}`, JSON.stringify({ s: store.statsId, e: "member@example.com", p: club.product.id, o: "", c: "co_Back0001", pc: 25, m: 1 }), "EX", seconds]]);
    return back;
  };
  const comeBack = async (back: string) => {
    checkouts.length = 0;
    const read = await readWinBack(store, club.product.id, back);
    const opened = await openWinBack(store, club.product.id, back, "https://marktmorgen.com", TEST_CONSENT);
    return { until: read?.until ?? null, opened: opened.ok ? "opened" : opened.reason, tries: checkouts.length, body: checkouts[0] };
  };
  let back = await grant(OFFER_DAYS * DAY);
  let wb = await comeBack(back);
  is("its until is the last moment the button opens", wb.until, now + OFFER_DAYS * DAY - OPEN);
  is("control: it opens", wb.opened, "opened");
  for (const left of [20 * 60, OPEN]) {
    back = await grant(left);
    wb = await comeBack(back);
    is(`${left} s left on the link: no offer shown, exactly as the button refuses`, [wb.until, wb.opened, wb.tries], [null, "expired", 0]);
  }
  back = await grant(OPEN + 60);
  wb = await comeBack(back);
  is("a minute more: shown, and opens", [wb.until, wb.opened], [now + 60, "opened"]);

  part("Come-back link: a discounted checkout made but not handed over is closed at Stripe");
  back = await grant(32 * 60);
  slowBy = 5 * 60;
  expired.length = 0;
  wb = await comeBack(back);
  slowBy = 0;
  is("control: made once, not handed over", [wb.tries, wb.opened], [1, "expired"]);
  is("the come-back checkout just made is closed (POST .../expire)", expired.length, 1);

  part("Come-back email: it names the effective end, with its hour");
  const sentAt = at(now);
  customers.set("cus_MemberEffect01", "member@example.com");
  await upsertContact(store.listId as string, "member@example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);
  events.push({
    id: "evt_sub_MemberEffect01",
    type: "customer.subscription.deleted",
    created: sentAt - 8 * DAY,
    data: { object: { id: "sub_MemberEffect01", customer: "cus_MemberEffect01", ended_at: sentAt - 8 * DAY, metadata: { store: "harbor", product: club.product.id }, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
  const was = mails.length;
  is("control: one come-back email", (await sendWinBacks(Date.now() + 30_000, sentAt * 1000)).sent, 1);
  const letter = mails[was];
  const link = /[?&]back=([0-9a-f]{40})/.exec(letter?.text ?? "")?.[1] ?? "";
  const named = moment(sentAt + OFFER_DAYS * DAY - OPEN);
  is("it names the day and the hour the button stops opening", letter?.text.includes(`until ${named}`), true);
  const kept = await readWinBack(store, club.product.id, link);
  is("and the link keeps it: never ends before the time the email named", kept !== null && kept.until >= sentAt + OFFER_DAYS * DAY - OPEN, true);

  part("A discounted checkout never carries Stripe's recovery link");
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Springfield, IL 62701", asks: true });
  store = (await storeForEmail(OWNER))!;
  seen = await welcome(asked + HOUR);
  is("control: the welcome checkout opens", seen.opened, "opened");
  is("no after_expiration recovery on it (its copy would carry the discount past the end)", checkouts[0]?.has("after_expiration[recovery][enabled]"), false);
  back = await grant(OFFER_DAYS * DAY);
  wb = await comeBack(back);
  is("control: the come-back checkout opens", wb.opened, "opened");
  is("no after_expiration recovery on it either", wb.body?.has("after_expiration[recovery][enabled]"), false);

  part("What the creator is told: the offer the buyer sees ends about half an hour early (pre-review, VR 2)");
  // Rule 23: new assertions, red on 6a4fdd4dbc. The creator picks "24 hours" or a 14-day link, and the buyer's offer
  // ends CHECKOUT_OPEN_SECONDS before that; the setting, the help and the come-back bullet now say so.
  is("'about half an hour' stays true of the time a checkout is kept open", CHECKOUT_OPEN_SECONDS >= 25 * 60 && CHECKOUT_OPEN_SECONDS <= 35 * 60, true);
  const early = /ends about half an hour (early|before)[^.]*so a last payment still fits/;
  const said = {
    welcome: readFileSync("components/welcome-offer-editor.tsx", "utf8"),
    help: readFileSync("lib/help-content.ts", "utf8"),
    comeBack: readFileSync("components/winback-editor.tsx", "utf8"),
  };
  is("the welcome offer's setting says so", early.test(said.welcome), true);
  is("the help on the welcome offer says so", early.test(said.help.slice(said.help.indexOf("Can I give a countdown offer"))), true);
  is("the come-back offer's setting says so", /The link works for \$\{OFFER_DAYS\} days[^`]*about half an hour[^`]*so a last payment still fits/.test(said.comeBack), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
