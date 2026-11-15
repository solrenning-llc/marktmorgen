/**
 * The erasure check is read only in its exact shape (sweep A6 F1, CX-123
 * rule 24/30). HEXISTS answers the integer 0 or 1; anything else (no reply,
 * a cut-short pipeline, text, another number) is unknown, and an unknown
 * answer is never "not deleted": lib/suppression.ts wasSuppressed and
 * isSuppressed throw UnknownReplyError, so
 *
 *   - lib/contacts.ts upsertContact never puts a person deleted from the store
 *     back on its list as agreeing, from a purchase without their own yes;
 *   - lib/checkout-recovery.ts never sends the checkout reminder;
 *   - lib/product-updates.ts never sends the update email, and the job stays
 *     queued to be tried again (a temporary error, not a finished send).
 *
 * The controls show each path still reads a healthy answer: deleted is
 * skipped, not deleted goes ahead. lib/review-requests.ts already reads the
 * same command this way (reviewRecipientState). Synthetic records, the
 * in-memory Redis and stand-in senders only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSuppressed, suppressCommand, wasSuppressed } from "@/lib/suppression";
import { UnknownReplyError } from "@/lib/redis-reply";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { remindAbandoned } from "@/lib/checkout-recovery";
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { type ReadingGuard, keptReading } from "@/lib/store-readings";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_suppression_exact_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

type Mail = { to: string };
const sent: Mail[] = [];
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)) as { to: string | string[] }[];
      for (const m of batch) sent.push({ to: [m.to].flat()[0] });
      return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
    }
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    sent.push({ to: [body.to].flat()[0] });
    return Response.json({ id: `email_${sent.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  return list([]);
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
const hasCheck = (commands: Commands) => commands.some((c) => c[0] === "HEXISTS" && String(c[1]).startsWith("nl:erased:"));
/** Every erasure check's slot answered with `value` (null: nothing came back for it). */
const blankChecks = (value: unknown) => async (commands: Commands, real: Pipe) => {
  const replies = await real(commands);
  return replies.map((reply, i) => (commands[i][0] === "HEXISTS" ? value : reply));
};
const contact = async (list: string, email: string) => parseContact((await redis.pipeline([["HGET", leadsKey(list), email]]))[0]);

test("control: wasSuppressed reads HEXISTS's exact 1 and 0", () => {
  assert.equal(wasSuppressed(1), true);
  assert.equal(wasSuppressed(0), false);
});

test("an HEXISTS reply of any other shape is unknown, never 'not deleted'", () => {
  for (const reply of [undefined, null, "", "0", "1", 2, -1, 0.5, Number.NaN, true, false, [1], [0], { 0: 1 }]) {
    assert.throws(() => wasSuppressed(reply), UnknownReplyError, `wasSuppressed(${JSON.stringify(reply)}) must throw`);
  }
});

test("control: isSuppressed answers true for a deleted address and false for another", async () => {
  await redis.pipeline([suppressCommand("suppx-list0", "gone@example.com")]);
  assert.equal(await isSuppressed("suppx-list0", "gone@example.com"), true);
  assert.equal(await isSuppressed("suppx-list0", "Gone@Example.com"), true);
  assert.equal(await isSuppressed("suppx-list0", "here@example.com"), false);
  assert.equal(await isSuppressed(null, "gone@example.com"), false);
});

test("isSuppressed throws on a missing, cut-short or other-shaped reply", async () => {
  await redis.pipeline([suppressCommand("suppx-list0b", "gone@example.com")]);
  for (const replies of [[], [null], ["1"], [1, 1], null]) {
    await assert.rejects(intercept(hasCheck, async () => replies as unknown[], () => isSuppressed("suppx-list0b", "gone@example.com")), UnknownReplyError, JSON.stringify(replies));
    await assert.rejects(intercept(hasCheck, async () => replies as unknown[], () => isSuppressed("suppx-list0b", "here@example.com")), UnknownReplyError, JSON.stringify(replies));
  }
});

test("control: upsertContact keeps a deleted person off as agreeing, and lets anyone else agree", async () => {
  await redis.pipeline([suppressCommand("suppx-list1", "erased@example.com")]);
  await upsertContact("suppx-list1", "erased@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM);
  assert.equal((await contact("suppx-list1", "erased@example.com"))?.agreed, false);
  await upsertContact("suppx-list1", "kept@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM);
  assert.equal((await contact("suppx-list1", "kept@example.com"))?.agreed, true);
});

test("upsertContact refuses, writing nothing, when the erasure check's reply is unknown", async () => {
  await redis.pipeline([suppressCommand("suppx-list2", "erased@example.com")]);
  // The pipeline cut short: the third slot (HEXISTS) is missing.
  await assert.rejects(
    intercept(hasCheck, async (commands, real) => (await real(commands)).slice(0, 2), () =>
      upsertContact("suppx-list2", "erased@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM)),
    UnknownReplyError,
  );
  assert.equal(await contact("suppx-list2", "erased@example.com"), null, "an erased person was written back on the list");
  // The slot there but of another shape.
  await assert.rejects(
    intercept(hasCheck, blankChecks("0"), () => upsertContact("suppx-list2", "erased@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM)),
    UnknownReplyError,
  );
  assert.equal(await contact("suppx-list2", "erased@example.com"), null, "an erased person was written back on the list");
});

const RECOVER_OWNER = "suppx-recover@example.com";
let recoverProduct = "";
async function recoverStore() {
  if (!recoverProduct) {
    await claimHandle(RECOVER_OWNER, "suppxkiln", "Suppx Kiln", "");
    await ensureStatsId(RECOVER_OWNER);
    await ensureListId(RECOVER_OWNER);
    await setStripeAccount(RECOVER_OWNER, "acct_1TestSuppx00001", true);
    await setSubscription(RECOVER_OWNER, { customerId: "cus_Suppx00001", subscriptionId: "sub_Suppx00001", active: true, period: paidPeriod() });
    await setRecovery(RECOVER_OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
    const made = await addProduct(RECOVER_OWNER, "Glaze Recipes", "", "24", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(RECOVER_OWNER, made.product.id, `https://example.com/${made.product.id}`);
    recoverProduct = made.product.id;
  }
  return (await storeForEmail(RECOVER_OWNER))!;
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
    metadata: { store: "suppxkiln", product: recoverProduct },
  } as never;
};

test("control: the checkout reminder skips a deleted address and goes to another", async () => {
  const store = await recoverStore();
  await redis.pipeline([suppressCommand(store.listId!, "erased@example.com")]);
  const before = sent.length;
  assert.equal(await remindAbandoned(store, left("cs_test_suppxerased001", "erased@example.com")), "skip");
  assert.equal(sent.length, before);
  assert.equal(await remindAbandoned(store, left("cs_test_suppxkept00001", "kept@example.com")), "sent");
  assert.deepEqual(sent.slice(before).map((m) => m.to), ["kept@example.com"]);
});

test("the checkout reminder is not sent when the erasure check's reply is unknown", async () => {
  const store = await recoverStore();
  await redis.pipeline([suppressCommand(store.listId!, "erased2@example.com")]);
  const before = sent.length;
  for (const [id, email, value] of [
    ["cs_test_suppxunknown001", "erased2@example.com", null],
    ["cs_test_suppxunknown002", "erased2@example.com", "1"],
    ["cs_test_suppxunknown003", "other@example.com", null],
  ] as const) {
    await assert.rejects(intercept(hasCheck, blankChecks(value), () => remindAbandoned(store, left(id, email))), UnknownReplyError, `${id}: must not be read as not deleted`);
  }
  assert.deepEqual(sent.slice(before).map((m) => m.to), [], "a reminder went out on an unknown erasure check");
});

const UPDATE_OWNER = "suppx-update@example.com";
test("product updates: an unknown erasure check sends nothing and leaves the job to be tried again; a healthy one skips only the deleted", async () => {
  await claimHandle(UPDATE_OWNER, "suppxharbor", "Suppx Harbor", "");
  await ensureStatsId(UPDATE_OWNER);
  await ensureListId(UPDATE_OWNER);
  await setStripeAccount(UPDATE_OWNER, "acct_1TestSuppxHb001", true);
  await setSubscription(UPDATE_OWNER, { customerId: "cus_SuppxHb001", subscriptionId: "sub_SuppxHb001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(UPDATE_OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(UPDATE_OWNER, "Weekly Meal Planner", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(UPDATE_OWNER, made.product.id, "https://example.com/planner");
  const load = async () => (await storeForEmail(UPDATE_OWNER))!;
  const paid = (id: string, email: string) => ({
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: Math.floor(Date.now() / 1000) - 86_400,
    amount_total: 2700,
    currency: "usd",
    customer_details: { email },
    metadata: { store: "suppxharbor", product: made.product.id },
  });
  sessions = [paid("cs_suppx_u1", "ana@example.com"), paid("cs_suppx_u2", "erased@example.com")];
  const store = await load();
  await redis.pipeline([suppressCommand(store.listId!, "erased@example.com")]);
  const product = (await readListing(store, made.product.id))!;
  const started = await startUpdate(store, product, "Ten new recipes.");
  if (!started.ok) throw new Error(`not started: ${started.reason}`);

  const before = sent.length;
  // main's advanceUpdate (checkedUpdateRecipients) parks the job as "waiting" on an unknown check instead of throwing.
  const held = await intercept(hasCheck, blankChecks(null), () => advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000));
  assert.equal(held?.status, "waiting", "an unknown erasure check must leave the job to be tried again");
  assert.deepEqual(sent.slice(before).map((m) => m.to), [], "an update went out on an unknown erasure check");
  const waiting = await readUpdateJob(started.job.id);
  assert.notEqual(waiting?.status, "sent");
  assert.equal(waiting?.done, 0, "the unknown check was counted as done");

  // Control: with Redis answering, the next run sends to Ana only.
  const job = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  assert.equal(job?.status, "sent");
  assert.deepEqual(sent.slice(before).map((m) => m.to), ["ana@example.com"]);
});

// Rule 30 sibling of keepUnlessErased (Claude 6's review of #2865, LOW): lib/store-readings.ts keptReading reads the
// same step's reply (READING_COPY = KEEP_UNLESS_ERASED). A list of places with a hole, or a slot that is a getter,
// is not a whole answer: Array#every skips a hole, so the erased buyer was shown and the old copy naming them kept.
type Top = { top: string[] };
const readingGuard = (listId: string): ReadingGuard<Top> => ({ listId, names: (v) => v.top, without: (v, gone) => ({ top: v.top.filter((e) => !gone.has(e)) }) });
const isReadingCopy = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:reading-copy:"));
const withGetter = () => {
  const list: unknown[] = [];
  Object.defineProperty(list, 0, { get: () => 1, enumerable: true, configurable: true });
  return list;
};

test("control: a kept reading leaves out a buyer deleted before it is kept, and keeps one naming only the others", async () => {
  await redis.pipeline([suppressCommand("suppx-list-r0", "erased@example.com")]);
  const read = async (): Promise<Top> => ({ top: ["erased@example.com", "kept@example.com"] });
  const kept = await keptReading({ statsId: "suppx-stats-r0" }, "sales", read, Date.now(), true, readingGuard("suppx-list-r0"));
  assert.deepEqual(kept?.value, { top: ["kept@example.com"] });
  const clean = await keptReading({ statsId: "suppx-stats-r0b" }, "sales", async () => ({ top: ["kept@example.com"] }), Date.now(), true, readingGuard("suppx-list-r0"));
  assert.deepEqual(clean?.value, { top: ["kept@example.com"] });
  assert.ok(String((await redis.pipeline([["GET", "nl:reading:sales:suppx-stats-r0b"]]))[0]).includes("kept@example.com"));
});

test("a kept reading whose check answers a holey, getter or cut-short list of places names nobody and keeps no copy", async () => {
  await redis.pipeline([suppressCommand("suppx-list-r1", "erased@example.com")]);
  const shapes: [string, () => unknown[]][] = [
    ["a list of places with a hole", () => [new Array(1)]],
    ["a place behind a getter", () => [withGetter()]],
    ["a pipeline with a hole", () => new Array(1)],
  ];
  const wrong: string[] = [];
  for (const [label, answer] of shapes) {
    const statsId = `suppx-stats-r1-${shapes.findIndex(([l]) => l === label)}`;
    const copy = `nl:reading:sales:${statsId}`;
    // An older copy naming them: the step's answer is unknown, so it goes.
    await redis.pipeline([["SET", copy, JSON.stringify({ at: Date.now() - 86_400_000, value: { top: ["erased@example.com"] } }), "EX", 3600]]);
    const read = async (): Promise<Top> => ({ top: ["erased@example.com", "kept@example.com"] });
    const kept = await intercept(isReadingCopy, async () => answer(), () => keptReading({ statsId }, "sales", read, Date.now(), true, readingGuard("suppx-list-r1")));
    if (JSON.stringify(kept?.value).includes("erased@example.com")) wrong.push(`${label}: the erased buyer was shown`);
    if ((await redis.pipeline([["GET", copy]]))[0] !== null) wrong.push(`${label}: a copy naming the erased buyer was kept`);
  }
  assert.deepEqual(wrong, []);
});
