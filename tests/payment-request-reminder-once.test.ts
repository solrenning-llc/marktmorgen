/**
 * A payment request's reminder is handed to the sender at most once, even when the answer is not known AND the
 * write that records it fails (Codex L, MEDIUM, review of #4501 @adc66664a7, 14/11/2026 04h09 Fortaleza).
 *
 * The send that may have gone counted as sent (rule 30), but the only durable mark was the write after the email:
 * when that write failed, the request kept its old count and its due day, and the daily job, a day later, when
 * neither sender still knows the idempotency key, handed the same reminder over again. Now the attempt is written
 * onto the request before the email goes (`sendingAt`), and a later run that finds it records the reminder as sent
 * without handing anything over: only a certain refusal lets the same reminder go again.
 * Synthetic only: the Redis stub and the SES mail fixture.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { REMIND_EVERY_DAYS, readDraft } from "@/lib/payment-request-rules";
import { createRequest, readRequest } from "@/lib/payment-request-store";
import { sendDueReminders, sendRequestEmail } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let holdReminder: (() => Promise<void>) | undefined;
const fixture = installSesMailFixture({
  onSes: (message) => {
    if (message.to.includes("overlap@example.com") && holdReminder) {
      return holdReminder().then(() => Response.json({ MessageId: "ses_fixture_overlap" }));
    }
    return undefined;
  },
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 }),
});
fixture.configure();
const handed = (to: string) => fixture.sesAttempts.filter((m) => m.to.includes(to)).length;
/** The SES once-only mark of a key lasts a day; the in-memory Redis keeps real time, so its expiry is played here. */
const aDayPasses = (...keys: string[]) => {
  for (const key of keys) redis.run(["DEL", `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`]);
};

/**
 * Makes the next write of this request's record fail once it is armed, as a Redis timeout would: armed only
 * after the email was handed over, so a write before the hand-over still goes through.
 */
const realPipeline = redis.pipeline.bind(redis);
let failWriteOf = "";
let armedAt = -1;
redis.pipeline = ((commands: (string | number)[][]) => {
  const write = commands.find((c) => c[0] === "EVAL" && c.some((a) => typeof a === "string" && a === `nl:payreq:r:${failWriteOf}`));
  if (failWriteOf && write && fixture.sesAttempts.length > armedAt) {
    failWriteOf = "";
    return Promise.reject(new Error("synthetic: the request's write timed out"));
  }
  return realPipeline(commands);
}) as typeof redis.pipeline;
const failNextWriteAfterSend = (id: string) => {
  failWriteOf = id;
  armedAt = fixture.sesAttempts.length;
};

const DAY = 86_400_000;
const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "scale", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function request(store: Store, email: string, now: number): Promise<string> {
  const draft = readDraft({ email, name: "Dana", lines: [LINE], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!draft.ok) throw new Error("no draft");
  const made = await createRequest(store, draft.draft, now);
  if (!made.ok) throw new Error("no request");
  await sendRequestEmail(store, made.request, now);
  return made.request.id;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  delete process.env.RESEND_API_KEY;
  const now = Date.now();
  const store = await paidStore("reminder-once@example.com", "reminderonce");
  const firstDay = now + REMIND_EVERY_DAYS * DAY + 1;

  part("An unknown answer, then the write that records it fails");
  const id = await request(store, "buyer@example.com", now);
  const toBuyer = () => handed("buyer@example.com");
  is("set-up: the request went", toBuyer(), 1);
  fixture.setSesOutcome("server-error");
  failNextWriteAfterSend(id);
  const failed = await sendDueReminders(Date.now() + 10_000, firstDay).then(() => "", (error: unknown) => String(error));
  is("the run stopped on the failed write", failed.includes("synthetic"), true);
  is("the reminder was handed to the sender once", toBuyer(), 2);

  part("A day on, when the sender no longer knows the key: never handed over again");
  fixture.setSesOutcome("ok");
  aDayPasses(`nimbus-payreq:${id}:1`);
  await sendDueReminders(Date.now() + 10_000, firstDay + DAY + 1);
  is("nothing more a day later", toBuyer(), 2);
  const after = (await readRequest(id))!;
  is("and the reminder is now written down as sent, at its attempt", [after.sent.length, after.sent[1] === firstDay, after.failed, after.sendingAt], [2, true, "", undefined]);
  await sendDueReminders(Date.now() + 10_000, firstDay + REMIND_EVERY_DAYS * DAY + 1);
  is("the second reminder goes on its own day", toBuyer(), 3);

  part("Control: a certain refusal, recorded, lets the same reminder go again a day later");
  const other = await request(store, "refused@example.com", now);
  const toRefused = () => handed("refused@example.com");
  fixture.setSesOutcome("refused");
  await sendDueReminders(Date.now() + 10_000, firstDay);
  const refused = (await readRequest(other))!;
  is("refused: not written down as sent, and no attempt left open", [toRefused(), refused.sent.length, refused.sendingAt, refused.failed !== ""], [2, 1, undefined, true]);
  fixture.setSesOutcome("ok");
  aDayPasses(`nimbus-payreq:${other}:1`);
  await sendDueReminders(Date.now() + 10_000, firstDay + DAY + 1);
  is("and sent the day after", [toRefused(), (await readRequest(other))!.sent.length], [3, 2]);

  part("Two workers completing the same reminder advance its number once");
  const overlap = await request(store, "overlap@example.com", now);
  const before = (await readRequest(overlap))!;
  let entered!: () => void;
  let release!: () => void;
  const atSender = new Promise<void>((resolve) => { entered = resolve; });
  const reply = new Promise<void>((resolve) => { release = resolve; });
  holdReminder = () => { entered(); return reply; };
  const first = sendRequestEmail(store, before, firstDay);
  await atSender;
  try {
    await sendRequestEmail(store, before, firstDay + 1);
  } finally {
    release();
    holdReminder = undefined;
  }
  await first;
  const completed = (await readRequest(overlap))!;
  is("one delivery attempt and one durable reminder", [handed("overlap@example.com"), completed.sent, completed.sendingAt], [2, [now, firstDay], undefined]);
  done();
}

void main();
