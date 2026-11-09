/**
 * Rule 24 for payment request reminders (lib/payment-requests.ts, sendDueReminders):
 * a store or request read that fails (a Redis timeout) is an unknown answer,
 * never "gone". The reminder stays on the due list, moved later so the same
 * run does not loop on it, and is tried again; only a store or request that
 * is confirmed missing takes it off the list.
 *
 * Checked in the in-memory Redis with Stripe and the email sender mocked.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { REMIND_EVERY_DAYS, readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { sendDueReminders, sendRequestEmail } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Mail = { to: string; subject: string };
const mails: Mail[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    mails.push({ to: body.to[0], subject: body.subject });
    return answer({ id: `email_${mails.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const draftBody = (over: Record<string, unknown> = {}) => ({ email: "client@example.com", name: "Dana", lines: [LINE], note: "Thank you for a good month.", dueDate: "", autoReminders: 2, consent: true, ...over });

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const DUE = "nl:payreq:due";
const score = async (sid: string, id: string) => redis.run(["ZSCORE", DUE, `${sid}|${id}`]);

/** A paid store with one request sent, its first reminder on the due list. */
async function remindable(owner: string, handle: string, email: string, now: number): Promise<{ store: Store; id: string }> {
  const store = await paidStore(owner, handle);
  const made = await createRequest(store, (readDraft(draftBody({ email, autoReminders: 2 }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  if (!made.ok) throw new Error(`could not make the request: ${made.message}`);
  const sent = await sendRequestEmail(store, made.request, now);
  if (!sent.sent) throw new Error(`could not send the request: ${JSON.stringify(sent)}`);
  return { store, id: made.request.id };
}

// While one of these keys is named, a GET of it throws, as a Redis timeout would.
let failingKey = "";
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (failingKey && commands.some((c) => c[0] === "GET" && c[1] === failingKey)) throw new Error("Redis request timed out (test)");
  return realPipeline(commands);
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  // A synthetic credential tests/resend-fixture-credentials.ts already knows.
  process.env.RESEND_API_KEY = "re_test_payment_requests_only_a_stand_in";
  const now = Date.now();
  const due = now + REMIND_EVERY_DAYS * 86_400_000 + 1;
  const sentTo = (email: string) => mails.filter((m) => m.to === email).length;
  const quiet = console.error;

  part("A store that cannot be read: the reminder waits, never dropped");
  const a = await remindable("unknown-store@example.com", "unknownstore", "a@example.com", now);
  is("the request's first reminder is on the due list", (await score(a.store.sid, a.id)) !== null, true);
  failingKey = `nl:store:id:${a.store.sid}`;
  console.error = () => undefined;
  await sendDueReminders(Date.now() + 30_000, due);
  console.error = quiet;
  failingKey = "";
  const afterA = await score(a.store.sid, a.id);
  is("still on the due list after the store read failed", afterA !== null, true);
  is("moved later than this run, so it is tried again and the run does not loop on it", afterA !== null && Number(afterA) > due, true);
  is("no reminder email went", sentTo("a@example.com"), 1);

  part("A request that cannot be read: the reminder waits, never dropped");
  const b = await remindable("unknown-request@example.com", "unknownreq", "b@example.com", now);
  failingKey = `nl:payreq:r:${b.id}`;
  console.error = () => undefined;
  await sendDueReminders(Date.now() + 30_000, due);
  console.error = quiet;
  failingKey = "";
  const afterB = await score(b.store.sid, b.id);
  is("still on the due list after the request read failed", afterB !== null, true);
  is("moved later than this run", afterB !== null && Number(afterB) > due, true);
  is("no reminder email went", sentTo("b@example.com"), 1);

  part("Control: a store confirmed gone takes it off the list");
  const c = await remindable("gone-store@example.com", "gonestore", "c@example.com", now);
  await redis.run(["DEL", `nl:store:id:${c.store.sid}`]);
  await sendDueReminders(Date.now() + 30_000, due);
  is("dropped from the due list", await score(c.store.sid, c.id), null);
  is("no reminder email went", sentTo("c@example.com"), 1);

  part("Control: a request confirmed gone takes it off the list");
  const d = await remindable("gone-request@example.com", "gonereq", "d@example.com", now);
  await redis.run(["DEL", `nl:payreq:r:${d.id}`]);
  await sendDueReminders(Date.now() + 30_000, due);
  is("dropped from the due list", await score(d.store.sid, d.id), null);

  part("Once the reads work again, the waiting reminder goes");
  await sendDueReminders(Date.now() + 30_000, Number(afterA) + 1);
  is("the store's reminder is sent on the later run", sentTo("a@example.com"), 2);

  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
