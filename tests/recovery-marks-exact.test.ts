/**
 * The checkout reminder's marks are read only in their exact shape (CX-123
 * rule 24/30, PF1). Before sending, lib/checkout-recovery.ts reads:
 *
 *   - the Store assistant's own mark for the checkout (EXISTS: 0 or 1);
 *   - the sent, stop and once-a-week marks (EXISTS: 0 or 1), the list
 *     contact (HGET: text or nothing) and the erasure check, as one pipeline
 *     of exactly five replies;
 *   - the two SET NX claims taken before sending ("OK" when taken, nothing
 *     when another pass holds them).
 *
 * Anything else (no reply, a cut-short pipeline, text where a number goes,
 * another number) is unknown, never "not stopped" or "taken": the reminder
 * is not sent, the checkout is not marked as sent, and UnknownReplyError
 * says why. The controls show the healthy answers still send and skip as
 * before. Synthetic records, the in-memory Redis and stand-in senders only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UnknownReplyError } from "@/lib/redis-reply";
import { remindAbandoned } from "@/lib/checkout-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_marks_exact_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
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
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

type Commands = (string | number)[][];
type Pipe = (commands: Commands) => Promise<unknown[]>;
/** Answers the pipelines `when` picks with `answer`, every other one as Redis would. */
async function intercept<T>(when: (commands: Commands) => boolean, answer: (commands: Commands, real: Pipe) => Promise<unknown[]>, run: () => Promise<T>): Promise<T> {
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
const isAssisted = (commands: Commands) => commands.length === 1 && starts("EXISTS", "nl:assist:remind:")(commands);
const isMarks = (commands: Commands) => commands.length === 5 && starts("EXISTS", "nl:recover:sent:")(commands);
const isClaims = (commands: Commands) => commands.length === 2 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:recover:sent:") && commands[0].includes("NX");
/** The reply at `slot` replaced with `value` (the real command still runs). */
const slotAs = (slot: number, value: unknown) => async (commands: Commands, real: Pipe) => {
  const replies = await real(commands);
  return replies.map((reply, i) => (i === slot ? value : reply));
};

const OWNER = "recmarks@example.com";
let product = "";
async function shop() {
  if (!product) {
    await claimHandle(OWNER, "recmarkskiln", "Recmarks Kiln", "");
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestRecMarks01", true);
    await setSubscription(OWNER, { customerId: "cus_RecMarks0001", subscriptionId: "sub_RecMarks0001", active: true, period: paidPeriod() });
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
    metadata: { store: "recmarkskiln", product },
  } as never;
};
let n = 0;
/** A fresh checkout and address, so no earlier mark is in the way. */
const fresh = () => {
  n += 1;
  const tag = String(n).padStart(4, "0");
  return { id: `cs_test_recmarks${tag}`, email: `buyer${tag}@example.com` };
};
const markOf = async (id: string) => (await redis.pipeline([["GET", `nl:recover:sent:${id}`]]))[0];

/** The reminder must reject as unknown, send nothing and leave the checkout unmarked as sent. */
async function refuses(when: (c: Commands) => boolean, answer: (c: Commands, real: Pipe) => Promise<unknown[]>, label: string, noList = false) {
  const kept = await shop();
  // A store with no contact list: the fourth read is then a one-key EXISTS, read as exactly 0 or 1.
  const store = noList ? { ...kept, listId: null } : kept;
  const { id, email } = fresh();
  const before = sent.length;
  await assert.rejects(intercept(when, answer, () => remindAbandoned(store, left(id, email))), UnknownReplyError, `${label}: must be unknown`);
  assert.deepEqual(sent.slice(before), [], `${label}: a reminder went out on an unknown reply`);
  assert.notEqual(await markOf(id), "sent", `${label}: the checkout was marked as sent`);
}

const ODD = [undefined, null, "maybe", "0", "1", "", 2, -1, 0.5, Number.NaN, true, false, [0], { 0: 0 }];

test("control: healthy marks send once, then the sent mark skips", async () => {
  const store = await shop();
  const { id, email } = fresh();
  const before = sent.length;
  assert.equal(await remindAbandoned(store, left(id, email)), "sent");
  assert.deepEqual(sent.slice(before), [email]);
  assert.equal(await markOf(id), "sent");
  assert.equal(await remindAbandoned(store, left(id, email)), "skip");
  assert.equal(sent.length, before + 1);
});

test("control: the assistant's own mark, a stop and a taken claim each skip", async () => {
  const store = await shop();
  const a = fresh();
  await redis.pipeline([["SET", `nl:assist:remind:${a.id}`, "1"]]);
  assert.equal(await remindAbandoned(store, left(a.id, a.email)), "skip");
  const b = fresh();
  await redis.pipeline([["SET", `nl:recover:sent:${b.id}`, "sending"]]);
  assert.equal(await remindAbandoned(store, left(b.id, b.email)), "skip");
  // Another pass took the claim between the read and the SET NX: nothing came back for it.
  const c = fresh();
  const before = sent.length;
  assert.equal(await intercept(isClaims, async () => ["OK", null], () => remindAbandoned(store, left(c.id, c.email))), "skip");
  assert.equal(sent.length, before);
});

test("the Store assistant's mark of any other shape is unknown, never 'not checked'", async () => {
  for (const value of ODD) await refuses(isAssisted, slotAs(0, value), `assisted EXISTS ${String(value)}`);
  await refuses(isAssisted, async () => [], "assisted EXISTS with no reply");
  await refuses(isAssisted, async () => [0, 0], "assisted EXISTS with two replies");
});

test("the sent, stop and once-a-week marks of any other shape are unknown, never 'not stopped'", async () => {
  for (const slot of [0, 1, 2]) {
    for (const value of ODD) await refuses(isMarks, slotAs(slot, value), `mark ${slot} ${String(value)}`);
  }
});

test("a cut-short or overlong marks pipeline is unknown", async () => {
  await refuses(isMarks, async (c, real) => (await real(c)).slice(0, 4), "four replies");
  await refuses(isMarks, async (c, real) => (await real(c)).slice(0, 3), "three replies");
  await refuses(isMarks, async () => [], "no replies");
  await refuses(isMarks, async (c, real) => [...(await real(c)), 0], "six replies");
  await refuses(isMarks, async () => null as never, "no list");
});

test("the list contact of another shape is unknown, never 'still on the list'", async () => {
  for (const value of [undefined, 0, 1, true, ["x"], { unsub: false }]) await refuses(isMarks, slotAs(3, value), `contact ${String(value)}`);
});

test("with no contact list, the fourth read (a one-key EXISTS) of any other shape is unknown (Codex Z on #2929)", async () => {
  for (const value of ODD) await refuses(isMarks, slotAs(3, value), `no-list EXISTS ${String(value)}`, true);
});

test("control: with no contact list, healthy marks send once", async () => {
  const kept = await shop();
  const store = { ...kept, listId: null };
  const { id, email } = fresh();
  const before = sent.length;
  await remindAbandoned(store, left(id, email));
  assert.deepEqual(sent.slice(before), [email]);
});

test("an unknown stop link write leaves no stop link behind, with the address in it (Claude 5's LOW on #2951)", async () => {
  // The write may have landed although its reply is unknown; every pass that tries again would leave one more link,
  // kept 400 days with the address in it, that is never sent and that erasure may not find.
  const isLink = (commands: Commands) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:recover:link:");
  for (const [label, value] of [["QUEUED", "QUEUED"], ["nothing", null], ["a number", 1]] as const) {
    const store = await shop();
    const { id, email } = fresh();
    let key = "";
    await assert.rejects(
      intercept(isLink, async (commands, real) => {
        key = String(commands[0][1]);
        const replies = await real(commands);
        replies[0] = value as never;
        return replies;
      }, () => remindAbandoned(store, left(id, email))),
      UnknownReplyError,
      `${label}: must be unknown`,
    );
    assert.ok(key, `${label}: the stop link was written`);
    assert.equal((await redis.pipeline([["GET", key]]))[0], null, `${label}: the stop link that was never sent is still there`);
  }
});

test("control: a stop link written whole stays for the reminder it is sent in", async () => {
  const store = await shop();
  const { id, email } = fresh();
  let key = "";
  const isLink = (commands: Commands) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:recover:link:");
  await intercept(isLink, async (commands, real) => {
    key = String(commands[0][1]);
    return real(commands);
  }, () => remindAbandoned(store, left(id, email)));
  assert.ok(key, "the stop link was written");
  assert.notEqual((await redis.pipeline([["GET", key]]))[0], null, "the sent reminder's stop link is kept");
});

test("a claim reply other than OK or nothing is unknown: nothing is sent", async () => {
  for (const value of [undefined, "Ok", "ok", "", 1, 0, true, ["OK"], { ok: true }]) {
    await refuses(isClaims, slotAs(0, value), `sent claim ${String(value)}`);
    await refuses(isClaims, slotAs(1, value), `once claim ${String(value)}`);
  }
  await refuses(isClaims, async (c, real) => (await real(c)).slice(0, 1), "one claim reply");
  await refuses(isClaims, async () => [], "no claim replies");
});

// Claude 5's LOW on #2929 @ 62904755: when one claim answers "OK" and the other in another shape, the one taken here
// must not stay behind: the next pass, read whole, sends this checkout's reminder; and another checkout of the same
// buyer and product is not held back a week by a once mark no email went with.
test("an unknown once-a-week claim gives back the sent claim taken here; the once mark whose reply was lost stays", async () => {
  const store = await shop();
  const { id, email } = fresh();
  const before = sent.length;
  await assert.rejects(intercept(isClaims, slotAs(1, "QUEUED"), () => remindAbandoned(store, left(id, email))), UnknownReplyError);
  assert.deepEqual(sent.slice(before), [], "nothing goes on an unknown claim");
  assert.equal(await markOf(id), null, "the sent claim taken here is given back, not left 'sending' for two weeks");
  // The once mark's reply was lost, but its write ran: it may be there, so this week's reminder stays held (safe side).
  assert.equal(await remindAbandoned(store, left(id, email)), "skip", "the lost once mark is kept: no second email this week");
  assert.deepEqual(sent.slice(before), [], "none");
});

test("an unknown sent claim gives back the once-a-week claim it took, so another checkout of the buyer still gets one", async () => {
  const store = await shop();
  const { id, email } = fresh();
  const before = sent.length;
  await assert.rejects(intercept(isClaims, slotAs(0, "QUEUED"), () => remindAbandoned(store, left(id, email))), UnknownReplyError);
  assert.deepEqual(sent.slice(before), [], "nothing goes on an unknown claim");
  const other = `${id}x`;
  assert.equal(await remindAbandoned(store, left(other, email)), "sent", "the buyer's other checkout of the same product is not held back a week");
  assert.deepEqual(sent.slice(before), [email], "once");
});

/**
 * The fifth reply, the erasure check (lib/suppression.ts, HEXISTS), is read
 * as exactly as the other four (CX-116 second money review of #2929, F1):
 * 1 is erased, 0 is not, anything else is unknown. Read through
 * `Number(reply) === 1`, a lost reply (nothing, QUEUED, no slot) said "not
 * erased" and sent a paid reminder to an address the creator erased, and
 * `[1]` said "erased" by luck. Here the address really is erased, so only
 * an exact reading may let anything through, and none does.
 */
test("the erasure check of any other shape is unknown, never 'not erased'", async () => {
  const store = await shop();
  const listId = store.listId as string;
  // Control: the address really erased, read whole, is skipped and nothing goes.
  const kept = fresh();
  await redis.pipeline([suppressCommand(listId, kept.email)]);
  const before = sent.length;
  assert.equal(await remindAbandoned(store, left(kept.id, kept.email)), "skip", "control: an erased address is skipped");
  assert.deepEqual(sent.slice(before), [], "control: nothing went to an erased address");
  for (const value of [null, "QUEUED", undefined, [1], ...ODD]) {
    const { id, email } = fresh();
    await redis.pipeline([suppressCommand(listId, email)]);
    const at = sent.length;
    await assert.rejects(
      intercept(isMarks, slotAs(4, value), () => remindAbandoned(store, left(id, email))),
      UnknownReplyError,
      `erasure check ${JSON.stringify(value) ?? "undefined"}: must be unknown`,
    );
    assert.deepEqual(sent.slice(at), [], `erasure check ${String(value)}: a reminder went to an erased address`);
    assert.notEqual(await markOf(id), "sent", `erasure check ${String(value)}: the checkout was marked as sent`);
  }
});
