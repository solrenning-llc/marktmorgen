/**
 * Rule 24 for payment request reminders (lib/payment-requests.ts, sendDueReminders),
 * the off-shape answers: a store or request read that comes back in a shape
 * Redis never sends for a key that is there or not (a reply that is not a
 * string, a pipeline with the wrong number of replies, a record that is not a
 * request) is an unknown answer, never "gone". The reminder stays on the due
 * list, moved later, and is tried again; only an exact EXISTS of 0 on the
 * store's id key or on the request's record takes it off the list.
 *
 * Checked in the in-memory Redis with Stripe and the email sender mocked;
 * the off-shape replies are put in by wrapping the stub's pipeline.
 */
import { createHash } from "node:crypto";
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
/** The store record's own key, as lib/store.ts names it (ownerKey), so one store's read can be put off-shape. */
const ownerKeyOf = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

/** A paid store with one request sent, its first reminder on the due list. */
async function remindable(owner: string, handle: string, email: string, now: number): Promise<{ store: Store; id: string }> {
  const store = await paidStore(owner, handle);
  const made = await createRequest(store, (readDraft(draftBody({ email, autoReminders: 2 }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  if (!made.ok) throw new Error(`could not make the request: ${made.message}`);
  const sent = await sendRequestEmail(store, made.request, now);
  if (!sent.sent) throw new Error(`could not send the request: ${JSON.stringify(sent)}`);
  return { store, id: made.request.id };
}

// While a key is named here, a GET of it is answered off-shape: "slot" puts the
// value in that GET's reply slot; "short" answers the whole pipeline with no reply.
let offKey = "";
let offAnswer: { kind: "slot"; value: unknown } | { kind: "short" } = { kind: "short" };
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  const at = offKey ? commands.findIndex((c) => c[0] === "GET" && c[1] === offKey) : -1;
  if (at < 0) return realPipeline(commands);
  if (offAnswer.kind === "short") return [];
  const replies = await realPipeline(commands);
  const out = [...replies];
  out[at] = offAnswer.value;
  return out as typeof replies;
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
  const runOff = async (key: string, answer: typeof offAnswer) => {
    offKey = key;
    offAnswer = answer;
    console.error = () => undefined;
    try {
      await sendDueReminders(Date.now() + 30_000, due);
    } finally {
      console.error = quiet;
      offKey = "";
    }
  };
  const kept = async (label: string, sid: string, id: string, email: string) => {
    const after = await score(sid, id);
    is(`${label}: still on the due list`, after !== null, true);
    is(`${label}: moved later than this run, so it is tried again and the run does not loop on it`, after !== null && Number(after) > due, true);
    is(`${label}: no reminder email went`, sentTo(email), 1);
    return after;
  };

  part("The store's id read answers a value that is not a string: the reminder waits");
  const a = await remindable("offshape-id@example.com", "offshapeid", "a@example.com", now);
  is("the request's first reminder is on the due list", (await score(a.store.sid, a.id)) !== null, true);
  await runOff(`nl:store:id:${a.store.sid}`, { kind: "slot", value: undefined });
  const afterA = await kept("id read undefined", a.store.sid, a.id, "a@example.com");

  part("The store record's read answers no reply at all (a cut-short pipeline): the reminder waits");
  const e = await remindable("offshape-owner@example.com", "offshapeowner", "e@example.com", now);
  await runOff(ownerKeyOf("offshape-owner@example.com"), { kind: "short" });
  await kept("store record read cut short", e.store.sid, e.id, "e@example.com");

  part("The request's record read answers a number: the reminder waits");
  const b = await remindable("offshape-req-num@example.com", "offshapereqn", "b@example.com", now);
  await runOff(`nl:payreq:r:${b.id}`, { kind: "slot", value: 42 });
  await kept("record read 42", b.store.sid, b.id, "b@example.com");

  part("The request's record read answers text that is not a request: the reminder waits");
  const f = await remindable("offshape-req-json@example.com", "offshapereqj", "f@example.com", now);
  await runOff(`nl:payreq:r:${f.id}`, { kind: "slot", value: "{not json" });
  await kept("record read unreadable", f.store.sid, f.id, "f@example.com");

  part("Control: a store whose id key is truly gone takes it off the list");
  const c = await remindable("offshape-gone-store@example.com", "offshapegones", "c@example.com", now);
  await redis.run(["DEL", `nl:store:id:${c.store.sid}`]);
  await sendDueReminders(Date.now() + 30_000, due);
  is("dropped from the due list", await score(c.store.sid, c.id), null);
  is("no reminder email went", sentTo("c@example.com"), 1);

  part("Control: a request whose record is truly gone takes it off the list");
  const d = await remindable("offshape-gone-req@example.com", "offshapegoner", "d@example.com", now);
  await redis.run(["DEL", `nl:payreq:r:${d.id}`]);
  await sendDueReminders(Date.now() + 30_000, due);
  is("dropped from the due list", await score(d.store.sid, d.id), null);
  is("no reminder email went", sentTo("d@example.com"), 1);

  part("Once the reads answer in shape again, the waiting reminder goes");
  await sendDueReminders(Date.now() + 30_000, Number(afterA) + 1);
  is("the store's reminder is sent on the later run", sentTo("a@example.com"), 2);
  is("the request kept through a numeric read is sent too", sentTo("b@example.com"), 2);

  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
