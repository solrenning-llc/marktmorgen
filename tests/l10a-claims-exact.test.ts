/**
 * CX-123 rule 24, lot L10a (C4-20261105-2115-TODOS-1): marks taken with SET NX
 * so a thing is done once (a creator's email, a chat post, a job run) are read
 * exactly through lib/claim-mark.ts. Only "OK", or our own value read back, is
 * ours. An answer in another shape whose write did not land is unknown:
 * nothing is sent and no job runs on it this time, and nothing is let go. A
 * job's lock and the checkout-trouble email's mark are let go only while they
 * still hold this run's own value, so a run whose mark ran out never deletes
 * the mark another run took since.
 *
 * Replies the stand-in never gives by itself are injected for one pipeline:
 * "only" means the command never reached Redis (the write did not land),
 * "after" means it ran and Upstash answered in another shape.
 */
import { NextRequest } from "next/server";
import { checkQuiet } from "@/lib/quiet-sales";
import { checkAlerts } from "@/lib/store-alerts";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { noteOfferSale } from "@/lib/sale-events";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { StripeError } from "@/lib/stripe-account";
import type { Listing } from "@/lib/catalog";
import { type Store, claimHandle, ensureStatsId, setChatSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET as coursesCron } from "@/app/api/cron/courses/route";
import { GET as remindersCron } from "@/app/api/cron/reminders/route";
import { GET as discordCron } from "@/app/api/cron/discord/route";
import { GET as quietCron } from "@/app/api/cron/quiet/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_l10a_claims_stand_in";
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.DISCORD_CLIENT_ID = "123456789012345678";
process.env.DISCORD_CLIENT_SECRET = "l10a-discord-secret-stand-in";
process.env.DISCORD_BOT_TOKEN = "l10a-discord-bot-stand-in";

const OWNER = "l10a-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const emails: { to: string; subject: string }[] = [];
const posted: string[] = [];
let stripeCalls = 0;
let sessions: Record<string, unknown>[] = [];
let resendFails = false;
let duringSend: (() => void) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    duringSend?.();
    if (resendFails) return json({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject });
    return json({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api.stripe.com") {
    stripeCalls += 1;
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Commands = (string | number)[][];
const startsWith = (commands: Commands, name: string, prefix: string) =>
  commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix);

/** The first pipeline whose first command is `name` on a key starting `prefix` never reaches Redis; `reply` is all there is. */
async function withReplyOnly<T>(name: string, prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!used && startsWith(commands, name, prefix)) {
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

/** Like withReplyOnly, but the command ran: the write landed and only the answer is in another shape. */
async function withReplyAfter<T>(name: string, prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    const answer = await real(commands);
    if (!used && startsWith(commands, name, prefix)) {
      used = true;
      return reply;
    }
    return answer;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

/** After the job's lock is taken, another run takes it over (ours ran out), before the job ends. */
async function withLockTakenOver<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let taken = false;
  let swapped = false;
  redis.pipeline = (async (commands: Commands) => {
    if (taken && !swapped) {
      swapped = true;
      await real([["SET", lock, "another-run", "EX", 300]]);
    }
    const answer = await real(commands);
    if (startsWith(commands, "SET", lock)) taken = true;
    return answer;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

const SHAPES: [string, unknown][] = [
  ["queued", ["QUEUED"]],
  ["no reply", []],
  ["undefined", [undefined]],
  ["an extra reply", ["OK", "OK"]],
  ["a count", [1]],
];

async function quietSales(): Promise<void> {
  part("quiet-sales.ts: the day's check and the email are ours only on an exact claim");
  const now = Date.UTC(2026, 9, 20, 12);
  const store = { handle: "lquiet", previousHandles: [], name: "Quiet", email: OWNER, stripeAccountId: "acct_test", subscriptionActive: true } as unknown as Store;
  const quiet = Array.from({ length: 30 }, (_, i) => ({ id: `cs_q${i}`, created: (now - (20 + i) * DAY) / 1000, status: "complete", payment_status: "paid", metadata: { store: "lquiet" } }));
  for (const [label, reply] of SHAPES) {
    redis.clear();
    sessions = quiet;
    stripeCalls = 0;
    emails.length = 0;
    const outcome = await withReplyOnly("SET", "nl:quiet:seen:", reply, () => checkQuiet(store, now));
    is(`the day's check answered ${label}, not written: nothing read, nothing sent`, [outcome, stripeCalls, emails.length], ["skipped", 0, 0]);
    is("and nothing let go", redis.run(["EXISTS", `nl:quiet:seen:2026-10-20:lquiet`]), 0);
  }
  for (const [label, reply] of SHAPES) {
    redis.clear();
    emails.length = 0;
    const outcome = await withReplyOnly("SET", "nl:quiet:sent:", reply, () => checkQuiet(store, now));
    is(`the email's mark answered ${label}, not written: no email`, [outcome, emails.length], ["skipped", 0]);
  }
  redis.clear();
  emails.length = 0;
  stripeCalls = 0;
  is("the day's check answered in another shape but written: read back as ours, the email goes once", await withReplyAfter("SET", "nl:quiet:seen:", ["QUEUED"], () => checkQuiet(store, now)), "sent");
  is("one email", emails.length, 1);
  is("and the same day again is seen", await checkQuiet(store, now), "seen");
  redis.clear();
  emails.length = 0;
  is("the email's mark answered in another shape but written: ours, sent", await withReplyAfter("SET", "nl:quiet:sent:", [undefined], () => checkQuiet(store, now)), "sent");
  is("one email", emails.length, 1);
}

async function storeAlertsAndSales(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "lalerts", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLtenA0001", true);
  await setSubscription(OWNER, { customerId: "cus_LtenA00001", subscriptionId: "sub_LtenA00001", active: true, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  store = (await storeForEmail(OWNER))!;
  return store;
}

async function storeAlerts(): Promise<void> {
  part("store-alerts.ts: the day's look and each alert are ours only on an exact claim");
  const paid = (id: string) => ({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: 60_000,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
    metadata: { store: "lalerts", product: "nope", title: "Weeknight Club", channel: "instagram" },
  });
  const fresh = async () => {
    const store = await storeAlertsAndSales();
    await setSalesGoal(store.statsId!, 50_000, "usd");
    sessions = [paid("cs_test_ltenalert00001")];
    emails.length = 0;
    posted.length = 0;
    stripeCalls = 0;
    return store;
  };
  for (const [label, reply] of SHAPES) {
    const store = await fresh();
    const outcome = await withReplyOnly("SET", "nl:alert:seen:", reply, () => checkAlerts(store));
    is(`the day's look answered ${label}, not written: nothing read, nothing said`, [outcome, stripeCalls, emails.length, posted.length], [{ said: 0, skipped: true }, 0, 0, 0]);
  }
  for (const [label, reply] of SHAPES) {
    const store = await fresh();
    const outcome = await withReplyOnly("SET", `nl:alert:${store.statsId}:`, reply, () => checkAlerts(store));
    is(`an alert's mark answered ${label}, not written: not said`, [outcome.said, emails.length, posted.length], [0, 0, 0]);
  }
  const store = await fresh();
  const outcome = await withReplyAfter("SET", `nl:alert:${store.statsId}:`, ["QUEUED"], () => checkAlerts(store));
  is("an alert's mark answered in another shape but written: ours, said once by email and in the chat", [outcome.said, emails.length, posted.length], [1, 1, 1]);
}

async function offerSale(): Promise<void> {
  part("sale-events.ts: a one-click offer's sale is posted to the chat only on an exact claim");
  const product = { id: "p_l10a", title: "Weeknight Club" } as unknown as Listing;
  const payment = (id: string) => ({ id, amount: 2_900, currency: "usd", created: Math.floor(Date.now() / 1000) });
  for (const [label, reply] of SHAPES) {
    const store = await storeAlertsAndSales();
    posted.length = 0;
    await withReplyOnly("SET", "nl:sale:told:", reply, () => noteOfferSale(store, product, payment(`pi_l10a_${label.replace(/\W/g, "")}`)));
    is(`the sale's mark answered ${label}, not written: nothing posted`, posted.length, 0);
  }
  const store = await storeAlertsAndSales();
  posted.length = 0;
  await withReplyAfter("SET", "nl:sale:told:", ["QUEUED"], () => noteOfferSale(store, product, payment("pi_l10a_written")));
  is("answered in another shape but written: ours, posted once", posted.length, 1);
  await noteOfferSale(store, product, payment("pi_l10a_written"));
  is("and never twice", posted.length, 1);
}

async function checkoutTrouble(): Promise<void> {
  part("checkout-trouble.ts: the day's email is ours only on an exact claim, and let go only while it is ours");
  const refused = new StripeError(400, "account_invalid", "Your account cannot currently make live charges.");
  const now = Date.UTC(2026, 9, 20, 12);
  for (const [label, reply] of SHAPES) {
    const store = await storeAlertsAndSales();
    emails.length = 0;
    const outcome = await withReplyOnly("SET", "nl:cotrouble:mail:", reply, () => noteCheckoutTrouble(store, refused, now));
    is(`the email's mark answered ${label}, not written: counted, no email`, [outcome, emails.length], ["counted", 0]);
  }
  const store = await storeAlertsAndSales();
  const mark = `nl:cotrouble:mail:${store.statsId}:2026-10-20`;
  emails.length = 0;
  resendFails = true;
  duringSend = () => {
    // Our mark ran out while Resend was slow, and another run took the day's email.
    redis.run(["SET", mark, "another-run", "EX", 2 * 86_400]);
  };
  try {
    await noteCheckoutTrouble(store, refused, now);
  } finally {
    resendFails = false;
    duringSend = null;
  }
  is("a failed send lets go of its own mark only: the other run's mark stays", redis.run(["GET", mark]), "another-run");
  redis.run(["DEL", mark]);
  resendFails = true;
  try {
    await noteCheckoutTrouble(store, refused, now);
  } finally {
    resendFails = false;
  }
  is("and a failed send with its own mark still held lets it go, so the next refusal can tell", redis.run(["EXISTS", mark]), 0);
}

async function crons(): Promise<void> {
  const jobs: [string, string, (request: NextRequest) => Promise<Response>][] = [
    ["courses", "nl:courses:lock", coursesCron as (request: NextRequest) => Promise<Response>],
    ["reminders", "nl:remind:lock", remindersCron as (request: NextRequest) => Promise<Response>],
    ["discord", "nl:dc:lock", discordCron as (request: NextRequest) => Promise<Response>],
    ["quiet", "nl:quiet:lock", quietCron as (request: NextRequest) => Promise<Response>],
  ];
  for (const [name, lock, GET] of jobs) {
    part(`cron/${name}: the run's lock is ours only on an exact claim, and let go only while it is ours`);
    const call = () => GET(new NextRequest(`https://local.example/api/cron/${name}`));
    for (const [label, reply] of SHAPES) {
      redis.clear();
      let after = 0;
      const real = redis.pipeline.bind(redis);
      const counting = (async (commands: Commands) => {
        if (!startsWith(commands, "SET", lock) && !startsWith(commands, "GET", lock)) after += 1;
        return real(commands);
      }) as typeof redis.pipeline;
      redis.pipeline = counting;
      let response: Response;
      try {
        response = await withReplyOnly("SET", lock, reply, call);
      } finally {
        redis.pipeline = real;
      }
      const body = (await response.json()) as Record<string, unknown>;
      is(`the lock answered ${label}, not written: the job does not run`, [response.status, body.ok, body.error, after], [503, false, "lock_unknown", 0]);
    }
    redis.clear();
    redis.run(["SET", lock, "another-run", "EX", 300]);
    const busy = await call();
    is("held by another run: busy, as before", [busy.status, ((await busy.json()) as { busy?: boolean }).busy], [200, true]);
    is("and the other run's lock is left alone", redis.run(["GET", lock]), "another-run");
    redis.clear();
    await withLockTakenOver(lock, call);
    is("our lock ran out and another run took it: ours ending never deletes theirs", redis.run(["GET", lock]), "another-run");
    redis.clear();
    await call();
    is("our own lock is let go when the run ends", redis.run(["EXISTS", lock]), 0);
  }
}

async function main(): Promise<void> {
  await quietSales();
  await storeAlerts();
  await offerSale();
  await checkoutTrouble();
  await crons();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
