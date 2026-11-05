/**
 * MM-SA-02: a paid payment request could be written back as open.
 *
 * A request's record is read, changed and written back by several hands: the
 * reminder that emails it (lib/payment-requests.ts, sendRequestEmail), the
 * press that opens its checkout (openRequestCheckout), the creator's cancel,
 * and the buyer coming back from paying (markPaid). Each wrote the whole
 * record it had read, so one that had read it before the payment and wrote
 * after it — a reminder still sending its email, a checkout still being
 * opened at Stripe — put the request back to open. Open again, it emailed
 * the person who had paid more reminders and opened a second checkout for a
 * second payment.
 *
 * Proved against a real Redis: each of those writers is held at its slow
 * step (the email, Stripe's answer) while the buyer's payment is written,
 * and the request must stay paid, its reminders stopped, and no second
 * checkout opened for it.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { cancelRequest, createRequest, markPaid, readRequest } from "@/lib/payment-request-store";
import { openRequestCheckout, sendRequestEmail } from "@/lib/payment-requests";
import { redisPipeline } from "@/lib/redis";
import { paidPeriod } from "../billing-period-fixture";
import { check, finish } from "./check";

const slow = { mail: 0, stripe: 0, recordRead: 0 };
const mails: string[] = [];
const sessions = new Map<string, Record<string, unknown>>();
let opened = 0;
const expired: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let enteredSlowMail: (() => void) | null = null;
let slowMailEntries = 0;
/** Observe the real mocked provider entry; a refused send cannot stand in for
 * a race with an in-flight email. No mutation starts before this ACK. */
function expectSlowMail(): Promise<void> {
  const expected = slowMailEntries + 1;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { enteredSlowMail = null; reject(new Error("The slow synthetic mail provider was never reached")); }, 5_000);
    enteredSlowMail = () => {
      enteredSlowMail = null;
      clearTimeout(timer);
      check("the exact next slow synthetic provider POST began before the concurrent write", ++slowMailEntries, expected);
      resolve();
    };
  });
}

const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (String(url).startsWith(String(process.env.UPSTASH_REDIS_REST_URL))) {
    // The record read that a slow writer starts from, held while another hand writes.
    if (slow.recordRead && String(init?.body).includes('"GET","nl:payreq:r:')) {
      const hold = slow.recordRead;
      slow.recordRead = 0;
      const reply = await real(input as string, init);
      await wait(hold);
      return reply;
    }
    return real(input as string, init);
  }
  if (url.hostname === "api.resend.com") {
    if (slow.mail) {
      const delay = slow.mail;
      enteredSlowMail?.();
      await wait(delay);
    }
    mails.push(String(init?.body));
    return answer({ id: `email_${mails.length}` });
  }
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === "/checkout/sessions" && method === "POST") {
      if (slow.stripe) await wait(slow.stripe);
      opened += 1;
      const body = new URLSearchParams(String(init?.body));
      const id = `cs_test_${String(opened).padStart(24, "q")}`;
      const metadata: Record<string, string> = {};
      for (const [key, value] of body) {
        const m = /^metadata\[(.+)\]$/.exec(key);
        if (m) metadata[m[1]] = value;
      }
      sessions.set(id, { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, metadata, created: Math.floor(Date.now() / 1000) });
      return answer(sessions.get(id));
    }
    if (/^\/checkout\/sessions\/[^/]+\/expire$/.test(path) && method === "POST") {
      const id = decodeURIComponent(path.split("/")[3]);
      expired.push(id);
      const found = sessions.get(id);
      if (found) found.status = "expired";
      return answer(found ?? {});
    }
    if (path.startsWith("/checkout/sessions/") && method === "GET") {
      const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
      return found ? answer(found) : answer({ error: { message: "No such checkout" } }, 404);
    }
    return answer({ object: "list", data: [], has_more: false });
  }
  throw new Error(`no network in this check: ${url.hostname}`);
}) as typeof fetch;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };

async function newRequest(store: Store, email: string) {
  const read = readDraft({ email, name: "Dana", lines: [LINE], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd");
  if (!read.ok) throw new Error(read.problem);
  const made = await createRequest(store, read.draft);
  if (!made.ok) throw new Error(made.message);
  return made.request;
}

/** What Stripe hands back for a settled checkout of a request. */
const settled = (id: string) => ({ id: `cs_test_${id.slice(0, 24).padEnd(24, "p")}`, amount_total: 48_000, payment_intent: `pi_${id.slice(0, 20)}`, created: Math.floor(Date.now() / 1000) });

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_security_journey_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_security_journey_only_a_stand_in";
  const owner = "owner@request-state.example";
  await claimHandle(owner, "request-state", "Request State Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1RequestStateX", true);
  await setSubscription(owner, { customerId: "cus_requeststate", subscriptionId: "sub_requeststate", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;

  // 1. A reminder is still sending its email when the buyer pays.
  const a = await newRequest(store, "reminded@example.com");
  slow.mail = 600;
  const reminderEntered = expectSlowMail();
  const reminding = sendRequestEmail(store, a);
  await reminderEntered;
  const paidA = await markPaid(store, a.id, settled(a.id));
  slow.mail = 0;
  await reminding;
  const afterA = await readRequest(a.id);
  check("a request paid while its reminder was being sent stays paid", [paidA?.request.state, afterA?.state], ["paid", "paid"]);
  const [dueA] = await redisPipeline([["ZSCORE", "nl:payreq:due", `${store.sid}|${a.id}`]]);
  check("and no reminder is left waiting for the person who paid", dueA, null);
  const before = opened;
  const again = await openRequestCheckout(store, a.id, "https://marktmorgen.com");
  check("and no second checkout is opened for it", [again.ok, opened - before], [false, 0]);

  // 2. The checkout is still being opened at Stripe when the buyer pays (an earlier checkout).
  const b = await newRequest(store, "opened@example.com");
  slow.stripe = 600;
  const opening = openRequestCheckout(store, b.id, "https://marktmorgen.com");
  await wait(150);
  await markPaid(store, b.id, settled(b.id));
  slow.stripe = 0;
  const answered = await opening;
  check("a request paid while a checkout was being opened for it stays paid", (await readRequest(b.id))?.state, "paid");
  check("and the checkout opened meanwhile is closed, not handed to the buyer", [answered.ok, expired.length], [false, 1]);

  // 3. The creator cancels it while the buyer's payment is being written.
  const c = await newRequest(store, "canceled@example.com");
  slow.recordRead = 600;
  const canceling = cancelRequest(store, c.id);
  await wait(150);
  await markPaid(store, c.id, settled(c.id));
  await canceling;
  check("a request paid while it was being canceled is paid, not canceled", (await readRequest(c.id))?.state, "paid");

  // 4. Two answers of the same payment at once: one receipt's worth, once.
  const d = await newRequest(store, "twice@example.com");
  slow.recordRead = 300;
  const [one, two] = await Promise.all([markPaid(store, d.id, settled(d.id)), (async () => (await wait(50), markPaid(store, d.id, settled(d.id))))()]);
  check("the same payment written twice at once is fresh only once", [one?.fresh, two?.fresh].filter(Boolean).length, 1);
  finish();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
