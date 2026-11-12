/**
 * PF1 sweep, CX-123 rule 24 (docs/reviews/pf1-sweep-r24.md): the checkout
 * reminder's other readings, each only in its exact shape.
 *
 *   - F1 the stop link a reminder carries (SET "OK" and its erasure notes):
 *     a reply of another shape sends no reminder with a link that may lead
 *     nowhere;
 *   - F2 the stop page's reading of a link (GET text or nothing, EXISTS 0 or
 *     1): another shape is unknown, never "no such link" or "not stopped";
 *   - F3 pressing stop (GET, then SET "OK"): another shape is unknown, never
 *     "Unsubscribed." and never "Not found.";
 *   - F4 whether the address paid since (Stripe's list of checkouts): no
 *     list, a page cut short or a row that is not an object is unknown, never
 *     "not paid", so no reminder goes to someone who paid;
 *   - F5 forgetting a person's once-a-week marks (DEL count): another shape
 *     is unknown, never "nothing here".
 *
 * The real functions over the in-memory Redis (tests/redis-stub.ts), with
 * only one pipeline's reply or Stripe's reply replaced. Controls show the
 * healthy answers still send, skip, stop and count as before. Synthetic
 * records and stand-in senders only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UnknownReplyError } from "@/lib/redis-reply";
import { forgetRecoveryPerson, readStopToken, remindAbandoned, stopReminders } from "@/lib/checkout-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_pf1_sweep_r24_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const HANDLE = "pfsweepkiln";
const sent: string[] = [];
/** What Stripe answers to the list of an address's completed checkouts (paidSince). */
let paidList: unknown = { object: "list", data: [], has_more: false };
/** An address the stand-in mail service refuses (the send-failed control). */
let refuseMailTo = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && refuseMailTo && String(init?.body).includes(refuseMailTo)) {
    return Response.json({ name: "application_error", message: "a synthetic refusal" }, { status: 500 });
  }
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)) as { to: string | string[] }[];
      for (const m of batch) sent.push([m.to].flat()[0]);
      return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
    }
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    sent.push([body.to].flat()[0]);
    return Response.json({ id: `email_${sent.length}` });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && url.searchParams.get("status") === "complete") {
    return new Response(JSON.stringify(paidList));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

type Commands = (string | number)[][];
type Pipe = (commands: Commands) => Promise<unknown[]>;
/** Answers the pipelines `when` picks with `answer`, every other one as Redis would. */
async function intercept<T>(when: (commands: Commands) => boolean, answer: (commands: Commands, real: Pipe) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const real: Pipe = (commands) => original.call(redis, commands);
  redis.pipeline = (async (commands: Commands) => (when(commands) ? answer(commands, real) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const starts = (op: string, prefix: string) => (commands: Commands) => commands[0]?.[0] === op && String(commands[0][1]).startsWith(prefix);
const isLinkWrite = starts("SET", "nl:recover:link:");
const isLinkRead = (c: Commands) => c.length === 1 && starts("GET", "nl:recover:link:")(c);
const isStopWrite = (c: Commands) => c.length === 1 && starts("SET", "nl:recover:off:")(c);
const isStopRead = (c: Commands) => c.length === 1 && starts("EXISTS", "nl:recover:off:")(c);
const isForget = (c: Commands) => c.length === 1 && starts("DEL", "nl:recover:once:")(c);
/** The reply at `slot` replaced with `value` (the real command still runs). */
const slotAs = (slot: number, value: unknown) => async (commands: Commands, real: Pipe) => {
  const replies = await real(commands);
  return replies.map((reply, i) => (i === slot ? value : reply));
};

const OWNER = "pfsweep@example.com";
let product = "";
async function shop() {
  if (!product) {
    await claimHandle(OWNER, HANDLE, "Pfsweep Kiln", "");
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestPfSweep001", true);
    await setSubscription(OWNER, { customerId: "cus_PfSweep00001", subscriptionId: "sub_PfSweep00001", active: true, period: paidPeriod() });
    await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
    const made = await addProduct(OWNER, "Glaze Recipes", "", "24", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    product = made.product.id;
  }
  return (await storeForEmail(OWNER))!;
}
const left = (id: string, email: string) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "checkout.session",
    status: "expired",
    payment_status: "unpaid",
    created: now - 3700,
    expires_at: now - 100,
    consent: { promotions: "opt_in" },
    customer_details: { email },
    metadata: { store: HANDLE, product },
  } as never;
};
let n = 0;
/** A fresh checkout and address, so no earlier mark is in the way. */
const fresh = () => {
  n += 1;
  const tag = String(n).padStart(4, "0");
  return { id: `cs_test_pfsweep${tag}`, email: `buyer${tag}@example.com` };
};
const markOf = async (id: string) => (await redis.pipeline([["GET", `nl:recover:sent:${id}`]]))[0];

/** The reminder must reject, send nothing and leave the checkout unmarked as sent. */
async function noReminder(run: (store: Awaited<ReturnType<typeof shop>>, id: string, email: string) => Promise<unknown>, label: string, kind: (new (...args: never[]) => Error) | null = UnknownReplyError) {
  const store = await shop();
  const { id, email } = fresh();
  const before = sent.length;
  if (kind) await assert.rejects(run(store, id, email), kind, `${label}: must be unknown`);
  else await assert.rejects(run(store, id, email), `${label}: must be unknown`);
  assert.deepEqual(sent.slice(before), [], `${label}: a reminder went out on an unknown reply`);
  assert.notEqual(await markOf(id), "sent", `${label}: the checkout was marked as sent`);
}

/** A stop link as a sent reminder leaves it, written straight into the stand-in. */
let tokens = 0;
async function stopToken(email: string): Promise<string> {
  const store = await shop();
  tokens += 1;
  const token = tokens.toString(16).padStart(40, "a");
  await redis.pipeline([["SET", `nl:recover:link:${token}`, JSON.stringify({ k: store.statsId, e: email, h: HANDLE, n: "Pfsweep Kiln" })]]);
  return token;
}

test("control: a healthy reminder sends once, carries a stop link that works, and its once mark is forgotten", async () => {
  const store = await shop();
  const { id, email } = fresh();
  const before = sent.length;
  assert.equal(await remindAbandoned(store, left(id, email)), "sent");
  assert.deepEqual(sent.slice(before), [email]);
  assert.equal(await markOf(id), "sent");
  assert.equal(await forgetRecoveryPerson(store.statsId, [product], email), 1);
  assert.equal(await forgetRecoveryPerson(store.statsId, [product], email), 0);
});

test("control: a paid checkout since, in a full list, skips the reminder", async () => {
  const store = await shop();
  const { id, email } = fresh();
  paidList = {
    object: "list",
    has_more: false,
    data: [{ id: "cs_test_paidrow0001", status: "complete", payment_status: "paid", metadata: { store: HANDLE, product } }],
  };
  try {
    const before = sent.length;
    assert.equal(await remindAbandoned(store, left(id, email)), "skip");
    assert.equal(sent.length, before);
  } finally {
    paidList = { object: "list", data: [], has_more: false };
  }
});

test("F4: a list of checkouts of another shape is unknown, never 'not paid'", async (t) => {
  const odd: [unknown, string][] = [
    [{ object: "list" }, "no data"],
    [{ object: "list", data: "none", has_more: false }, "data as text"],
    [{ object: "list", data: {}, has_more: false }, "data as an object"],
    [{ object: "list", data: [], has_more: true }, "a page cut short"],
    [{ object: "list", data: [null], has_more: false }, "a null row"],
    [{ object: "list", data: ["cs_test_x"], has_more: false }, "a row as text"],
  ];
  for (const [body, label] of odd) {
    await t.test(label, async () => {
      paidList = body;
      try {
        await noReminder((store, id, email) => remindAbandoned(store, left(id, email)), `paid list: ${label}`, null);
      } finally {
        paidList = { object: "list", data: [], has_more: false };
      }
    });
  }
});

test("F1: a stop link whose write is not answered in its exact shape sends no reminder", async (t) => {
  const cases: [(c: Commands, real: Pipe) => Promise<unknown>, string][] = [
    [slotAs(0, null), "SET answered nothing"],
    [slotAs(0, "QUEUED"), "SET answered QUEUED"],
    [slotAs(0, 1), "SET answered 1"],
    [slotAs(1, "x"), "ZADD answered text"],
    [slotAs(3, null), "EXPIRE answered nothing"],
    [async (c, real) => (await real(c)).slice(0, 1), "one reply for four commands"],
    [async () => [], "no replies"],
    [async () => ({}), "no list"],
  ];
  for (const [answer, label] of cases) {
    await t.test(label, () => noReminder((store, id, email) => intercept(isLinkWrite, answer, () => remindAbandoned(store, left(id, email))), `stop link: ${label}`));
  }
});

test("control: the stop page and the stop button with healthy replies", async () => {
  const store = await shop();
  const email = "stopper0001@example.com";
  const token = await stopToken(email);
  assert.deepEqual(await readStopToken(token), { email, storeName: "Pfsweep Kiln", stopped: false, handle: HANDLE });
  assert.equal(await stopReminders(token), true);
  assert.equal((await readStopToken(token))?.stopped, true);
  assert.equal(await stopReminders(token), true, "safe to press twice");
  assert.ok(store.statsId);
  // A link nobody made is not one: nothing else is said about it.
  assert.equal(await readStopToken("f".repeat(40)), null);
  assert.equal(await stopReminders("f".repeat(40)), false);
});

test("F2: the stop page's readings of another shape are unknown, never 'no such link' or 'not stopped'", async (t) => {
  const token = await stopToken("stopper0002@example.com");
  for (const [answer, label] of [
    [async () => [42], "GET answered a number"],
    [async () => [["x"]], "GET answered a list"],
    [async () => [], "GET with no reply"],
    [async () => ({}), "GET with no list"],
  ] as [(c: Commands, real: Pipe) => Promise<unknown>, string][]) {
    await t.test(label, () => assert.rejects(intercept(isLinkRead, answer, () => readStopToken(token)), UnknownReplyError, `stop page: ${label}`));
  }
  for (const [answer, label] of [
    [async () => [null], "EXISTS answered nothing"],
    [async () => ["1"], "EXISTS answered text"],
    [async () => [2], "EXISTS answered 2"],
    [async () => [], "EXISTS with no reply"],
  ] as [(c: Commands, real: Pipe) => Promise<unknown>, string][]) {
    await t.test(label, () => assert.rejects(intercept(isStopRead, answer, () => readStopToken(token)), UnknownReplyError, `stop page: ${label}`));
  }
});

test("F3: pressing stop with a reply of another shape is unknown, never 'Unsubscribed.' or 'Not found.'", async (t) => {
  for (const [answer, label] of [
    [async () => [42], "GET answered a number"],
    [async () => [], "GET with no reply"],
    [async () => ({}), "GET with no list"],
  ] as [(c: Commands, real: Pipe) => Promise<unknown>, string][]) {
    const token = await stopToken(`stopper-get-${label.length}@example.com`);
    await t.test(label, () => assert.rejects(intercept(isLinkRead, answer, () => stopReminders(token)), UnknownReplyError, `stop: ${label}`));
  }
  for (const [answer, label] of [
    [async () => [null], "SET answered nothing"],
    [async () => ["QUEUED"], "SET answered QUEUED"],
    [async () => [1], "SET answered 1"],
    [async () => [], "SET with no reply"],
  ] as [(c: Commands, real: Pipe) => Promise<unknown>, string][]) {
    const token = await stopToken(`stopper-set-${label.length}@example.com`);
    await t.test(label, () => assert.rejects(intercept(isStopWrite, answer, () => stopReminders(token)), UnknownReplyError, `stop: ${label}`));
  }
});

test("F3 at the door: an unknown stop write never says 'Unsubscribed.' nor 'Not found.', and the page offers the button again", async () => {
  await shop();
  const press = async (token: string, fromPage: boolean) => {
    const body = new URLSearchParams(fromPage ? { from: "page" } : {});
    return intercept(isStopWrite, async () => [null], () =>
      unsubscribePost(new NextRequest(`https://marktmorgen.test/api/mail/unsubscribe?r=${token}`, {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })));
  };
  const oneClick = await press(await stopToken("door-oneclick@example.com"), false);
  assert.equal(oneClick.status, 503, "a one-click stop whose write is unknown answers try again");
  const said = await oneClick.text();
  assert.ok(!/Unsubscribed|Not found/.test(said), `never a false answer: ${said}`);
  assert.match(said, /try again/i);
  const token = await stopToken("door-page@example.com");
  const fromPage = await press(token, true);
  assert.equal(fromPage.status, 303);
  assert.match(fromPage.headers.get("location") ?? "", /done=0/);
  assert.equal((await readStopToken(token))?.stopped, false, "not stopped, so the page shows the button again");
});

test("F5: forgetting the once-a-week marks with a reply of another shape is unknown, never 'nothing here'", async (t) => {
  const store = await shop();
  for (const [answer, label] of [
    [async () => [null], "DEL answered nothing"],
    [async () => ["1"], "DEL answered text"],
    [async () => [-1], "DEL answered -1"],
    [async () => [0.5], "DEL answered 0.5"],
    [async () => [], "DEL with no reply"],
    [async () => ({}), "DEL with no list"],
  ] as [(c: Commands, real: Pipe) => Promise<unknown>, string][]) {
    await t.test(label, () => assert.rejects(intercept(isForget, answer, () => forgetRecoveryPerson(store.statsId, [product], "gone@example.com")), UnknownReplyError, `forget: ${label}`));
  }
});

/**
 * CX-116 second money review of #2951, F1: the stop link is written after
 * the checkout's "sending" claim and its once-a-week mark were taken. When
 * that write is unknown, the reminder is not sent (F1 above) and both marks
 * go, as on the send-failed path: otherwise the "sending" mark stays for
 * 2 x ONCE_PER_SECONDS and every later pass skips the checkout, and the
 * address hears nothing about the product for a week, silently.
 */
test("control: a send that failed leaves no claim behind, and the next pass sends", async () => {
  const store = await shop();
  const { id, email } = fresh();
  refuseMailTo = email;
  try {
    assert.equal(await remindAbandoned(store, left(id, email)), "failed");
  } finally {
    refuseMailTo = "";
  }
  assert.equal(await markOf(id), null, "the send-failed path leaves no \"sending\" mark");
  const before = sent.length;
  assert.equal(await remindAbandoned(store, left(id, email)), "sent");
  assert.deepEqual(sent.slice(before), [email]);
});

test("an unknown stop link write leaves no claim behind, and the next pass sends", async (t) => {
  const cases: [(c: Commands, real: Pipe) => Promise<unknown>, string][] = [
    [slotAs(0, null), "SET answered nothing"],
    [slotAs(0, "QUEUED"), "SET answered QUEUED"],
    [slotAs(1, "x"), "ZADD answered text"],
    [async () => [], "no replies"],
  ];
  for (const [answer, label] of cases) {
    await t.test(label, async () => {
      const store = await shop();
      const { id, email } = fresh();
      const before = sent.length;
      await assert.rejects(intercept(isLinkWrite, answer, () => remindAbandoned(store, left(id, email))), UnknownReplyError, `${label}: must be unknown`);
      assert.deepEqual(sent.slice(before), [], `${label}: nothing goes on an unknown stop link`);
      const mark = await markOf(id);
      assert.equal(mark, null, `${label}: got the checkout's mark left at ${JSON.stringify(mark)}`);
      assert.equal(await remindAbandoned(store, left(id, email)), "sent", `${label}: the next pass, read whole, sends (no once-a-week mark left either)`);
      assert.deepEqual(sent.slice(before), [email], `${label}: once`);
    });
  }
});
