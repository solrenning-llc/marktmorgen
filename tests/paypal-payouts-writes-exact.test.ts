/**
 * The open-batch writes around a PayPal payout batch, each read exactly
 * (CX-123 rule 24, Claude 5, 09/11/2026; inventory of tolerant writes, lines
 * 301 and 398 of lib/paypal-payouts.ts).
 *
 * 1. PayPal named the batch and it is held under its id, but taking the "?"
 *    entry away failed. The same people were then counted twice (under the id
 *    and as "being checked"), and the settling sent the creator's money request
 *    to PayPal again, relying on PayPal alone not to make a second batch. The
 *    batch held under its id now names the request it came from, and the "?"
 *    entry it left is dropped without asking PayPal anything.
 * 2. The "?" entry could not be confirmed written (a reply of another shape, or
 *    no reply at all after Redis may have applied it). The press used to say
 *    "Nothing was sent" while the entry could still be there, and the daily
 *    settling then sent the batch. Now "Nothing was sent" is said only when the
 *    entry is confirmed gone; otherwise the press says the batch may still go.
 * 3. PayPal refused the batch (its balance, say), and taking the "?" entry away
 *    was not confirmed (pre-review of 09/11/2026). The press said "nothing was
 *    sent" and the payday email "Nothing left your PayPal", and the daily
 *    settling then sent the same request again, which PayPal could pay. The same
 *    rule now holds there: the press says the batch may still go.
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com.
 */
import { readFileSync } from "node:fs";
import { connectPayPal, onTheirWay, payoutUnknownMonth, paypalChecks, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { autoPayEmail } from "@/lib/affiliate-payday";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statswex01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
/** Every money request PayPal received, and the batches it made: one per PayPal-Request-Id, as PayPal does. */
let posts = 0;
/** When true, PayPal refuses the next money request for its balance (a 422 that names its error), and makes nothing. */
let refuseNext = false;
/** When true, PayPal refuses every token request (it is down), so the settling has no way to read a batch. */
let tokenDown = false;
const batches = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token" && tokenDown) return json({ name: "INTERNAL_SERVICE_ERROR" }, 500);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    if (refuseNext) {
      refuseNext = false;
      return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    }
    const key = String((init.headers as Record<string, string>)["PayPal-Request-Id"] ?? "");
    if (!batches.has(key)) batches.set(key, `BATCH${batches.size + 1}WEX`);
    return json({ batch_header: { payout_batch_id: batches.get(key), batch_status: "PENDING" } }, 201);
  }
  const read = /^\/v1\/payments\/payouts\/([A-Z0-9]+)$/.exec(url.pathname);
  if (read && [...batches.values()].includes(read[1])) {
    return json({
      batch_header: { batch_status: "SUCCESS" },
      items: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].map((aff) => ({ payout_item: { sender_item_id: aff }, transaction_status: "SUCCESS", payout_item_id: `ITEM${read[1]}${aff.slice(0, 4).toUpperCase()}` })),
      total_pages: 1,
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidwritesexact01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd", email: "owner@example.com",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  posts = 0;
  batches.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Runs `body` with one kind of pipeline answered by `fault` instead of Redis, the first time only. */
async function withFault<T>(match: (commands: Commands) => boolean, fault: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  let hit = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!hit && match(commands)) {
      hit = true;
      return fault(commands);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return { value: await body(), hit };
  } finally {
    redis.pipeline = real;
  }
}
const isUnknownDelete = (commands: Commands) => commands[0]?.[0] === "HDEL" && commands[0][1] === OPEN && String(commands[0][2]).startsWith("?");
const isUnknownWrite = (commands: Commands) => commands[0]?.[0] === "HSET" && commands[0][1] === OPEN && String(commands[0][2]).startsWith("?");
const openFields = async () => {
  const [all] = await real([["HGETALL", OPEN]]);
  return (Array.isArray(all) ? all.filter((_, i) => i % 2 === 0) : Object.keys((all ?? {}) as object)).map(String).sort();
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_writes_exact_only";
  console.error = () => {};
  const store = shop();
  const month = new Date().toISOString().slice(0, 7);

  for (const how of ["throws", "answers in another shape"] as const) {
    part(`PayPal named the batch, and taking its "?" entry away ${how}: counted once, never asked of PayPal again`);
    await seed(store);
    const { value: paid, hit } = await withFault(isUnknownDelete, async (commands) => {
      if (how === "throws") throw new Error("Synthetic: the HDEL of the '?' entry failed");
      void commands;
      return ["QUEUED"];
    }, () => payWithPayPal(store));
    is("the HDEL of the '?' entry was the one that failed", hit, true);
    is("the press is paid, in the batch PayPal named", paid.ok ? [paid.batch, paid.people] : paid.reason, ["BATCH1WEX", 2]);
    is("the '?' entry is still there beside the batch's id", (await openFields()).length, 2);
    is("both affiliates on their way", [...(await onTheirWay(store))].sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    // Rule 23: new assertion, red on main (checking 2): a batch held under PayPal's id is not also "being checked".
    is("nobody is shown as being checked: the batch is known", await paypalChecks(store), { checking: 0, manual: 0 });
    const settled = await settlePayPal(store);
    // Rule 23: new assertion, red on main (2 money requests): the "?" left beside a held batch is never sent to PayPal again.
    is("the settling sends PayPal no second money request", posts, 1);
    is("both are paid once, from the batch's own items", [settled.paid, settled.released, settled.waiting], [2, 0, 0]);
    // Rule 23: new assertion, red on main (settled 1): the owner's monthly count holds only batches that were really unknown.
    is("no unknown batch is counted settled", (await payoutUnknownMonth(month))?.settled ?? -1, 0);
    is("nothing stays open", await openFields(), []);
    is("nobody is left on their way", (await onTheirWay(store)).size, 0);
    is("and nothing is left for the creator's own check", await paypalChecks(store), { checking: 0, manual: 0 });
  }

  part("The settling's own removal of the '?' entry left beside a held batch fails too: kept on its way, never sent, dropped next run");
  await seed(store);
  await withFault(isUnknownDelete, async () => {
    throw new Error("Synthetic: the HDEL of the '?' entry failed");
  }, () => payWithPayPal(store));
  const stuck = await withFault(isUnknownDelete, async () => {
    throw new Error("Synthetic: the settling's HDEL of the '?' entry failed");
  }, () => settlePayPal(store));
  is("the settling's removal was the one that failed", stuck.hit, true);
  // Rule 23: corrected from waiting 4 to 2 (Codex H2 LOW, review 5822092775 on #3335): the two people in the "?" entry
  // are the same two held under the batch's id, so they wait once; 4 counted each affiliate twice.
  is("nothing is asked of PayPal; the batch's two people wait once", [stuck.value.paid, stuck.value.waiting, posts], [0, 2, 1]);
  is("waiting is the people really on their way", stuck.value.waiting, (await onTheirWay(store)).size);
  is("the store stays in the daily job", (await real([["SISMEMBER", "nl:pp:stores", store.sid]]))[0], 1);
  is("and the '?' entry stays, so nobody in it is put in another batch", (await onTheirWay(store)).size, 2);
  const next = await settlePayPal(store);
  is("the next run drops it and pays the batch once, with no second money request", [next.paid, next.waiting, posts, await openFields()], [2, 0, 1, []]);
  is("then nobody is left on their way", (await onTheirWay(store)).size, 0);

  part("The settling's removal of the '?' entry is applied but its answer is lost: the batch's people wait once");
  await seed(store);
  await withFault(isUnknownDelete, async () => {
    throw new Error("Synthetic: the HDEL of the '?' entry failed");
  }, () => payWithPayPal(store));
  const lost = await withFault(isUnknownDelete, async (commands) => {
    await real(commands);
    throw new Error("Synthetic: the settling's HDEL was applied and its answer lost");
  }, () => settlePayPal(store));
  is("the settling's removal was the one whose answer was lost", lost.hit, true);
  // Rule 23: new assertion, red at 9d80ba98 (waiting 4): the same two affiliates are not counted twice.
  is("nothing paid, nothing asked of PayPal, the two people wait once", [lost.value.paid, lost.value.waiting, posts], [0, 2, 1]);
  const after = await settlePayPal(store);
  is("the next run pays the batch once", [after.paid, after.waiting, posts, await openFields()], [2, 0, 1, []]);

  part("The '?' entry beside a held batch cannot be removed and PayPal gives no token: the batch's people wait once");
  await seed(store);
  await withFault(isUnknownDelete, async () => {
    throw new Error("Synthetic: the HDEL of the '?' entry failed");
  }, () => payWithPayPal(store));
  tokenDown = true;
  const noAuth = await withFault(isUnknownDelete, async () => {
    throw new Error("Synthetic: the settling's HDEL of the '?' entry failed");
  }, () => settlePayPal(store)).finally(() => { tokenDown = false; });
  is("the settling's removal failed while PayPal gave no token", noAuth.hit, true);
  // Rule 23: new assertion, red at 9d80ba98 (waiting 4): without a token the open batches are summed once each.
  is("nothing paid and the two people wait once", [noAuth.value.paid, noAuth.value.waiting], [0, 2]);
  is("and two people are really on their way", (await onTheirWay(store)).size, 2);
  const healed = await settlePayPal(store);
  is("the next run, with a token, pays the batch once", [healed.paid, healed.waiting, posts, await openFields()], [2, 0, 1, []]);

  part("The '?' entry cannot be confirmed written, and taking it away is confirmed: nothing was sent, and nothing will be");
  await seed(store);
  const confirmedGone = await withFault(isUnknownWrite, async (commands) => {
    await real(commands);
    return ["OK", "OK"];
  }, () => payWithPayPal(store));
  is("the write's reply was of another shape", confirmedGone.hit, true);
  is("the press says nothing was sent", confirmedGone.value.ok ? "paid" : confirmedGone.value.reason, "error");
  is("nobody is on their way", (await onTheirWay(store)).size, 0);
  await settlePayPal(store);
  is("and the settling sends nothing", posts, 0);

  part("The '?' entry cannot be confirmed written, nor taken away: the press never says nothing will be sent");
  await seed(store);
  let deletes = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (isUnknownWrite(commands)) {
      await real(commands);
      return ["OK", "OK"];
    }
    if (isUnknownDelete(commands)) {
      deletes += 1;
      throw new Error("Synthetic: the HDEL of the '?' entry failed");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let both: Awaited<ReturnType<typeof payWithPayPal>>;
  try {
    both = await payWithPayPal(store);
  } finally {
    redis.pipeline = real;
  }
  is("taking it away was tried", deletes, 1);
  // Rule 23: new assertion, red on main ("error", whose words say "Nothing was sent"): the entry may be held and sent later.
  is("the press says the batch may still go", both.ok ? "paid" : both.reason, "pending");
  is("nothing was asked of PayPal by the press", posts, 0);
  is("its people stay on their way, never put in another batch", (await onTheirWay(store)).size, 2);
  const studio = /\n\s*pending: "([^"]+)"/.exec(readFileSync("components/paypal-payouts.tsx", "utf8"))?.[1] ?? "";
  is("the studio's words never say nothing will be sent", [studio !== "", /Nothing was sent\./.test(studio), studio.includes("on their way"), studio.includes("another way")], [true, false, true, true]);
  const email = autoPayEmail({ ok: false, reason: "pending" }, "usd");
  is("nor does the payday email", [email.text.includes("Nothing left your PayPal"), email.text.includes("on their way"), email.text.includes("another way")], [false, true, true]);

  for (const removal of ["confirmed", "failed"] as const) {
    part(`The write of the '?' entry got no answer after Redis applied it, and taking it away ${removal}`);
    await seed(store);
    redis.pipeline = (async (commands: Commands) => {
      if (isUnknownWrite(commands)) {
        await real(commands);
        throw new Error("Synthetic: the write's answer never came");
      }
      if (removal === "failed" && isUnknownDelete(commands)) throw new Error("Synthetic: the HDEL of the '?' entry failed");
      return real(commands);
    }) as typeof redis.pipeline;
    let lost: Awaited<ReturnType<typeof payWithPayPal>>;
    try {
      lost = await payWithPayPal(store);
    } finally {
      redis.pipeline = real;
    }
    is("nothing was asked of PayPal by the press", posts, 0);
    if (removal === "confirmed") {
      is("the press says nothing was sent", lost.ok ? "paid" : lost.reason, "error");
      // Rule 23: new assertion, red on main (the "?" entry stayed, 2 on their way): "Nothing was sent" holds only once it is gone.
      is("and nobody is left on their way", (await onTheirWay(store)).size, 0);
      await settlePayPal(store);
      // Rule 23: new assertion, red on main (1 money request): a press told "Nothing was sent" is never sent later.
      is("so the settling never sends it", posts, 0);
    } else {
      // Rule 23: new assertion, red on main ("error"): the entry may be held, so the press says it may still go.
      is("the press says the batch may still go", lost.ok ? "paid" : lost.reason, "pending");
      is("its people stay on their way", (await onTheirWay(store)).size, 2);
    }
  }

  for (const how of ["throws", "answers in another shape"] as const) {
    part(`PayPal refuses the batch for its balance, and taking the "?" entry away ${how}: never "nothing was sent"`);
    await seed(store);
    refuseNext = true;
    const { value: refused, hit } = await withFault(isUnknownDelete, async () => {
      if (how === "throws") throw new Error("Synthetic: the HDEL of the '?' entry failed");
      return ["QUEUED"];
    }, () => payWithPayPal(store));
    is("the HDEL of the '?' entry was the one that failed", hit, true);
    is("PayPal was asked once, and refused", posts, 1);
    // Rule 23: new assertion, red on main and on this branch before the fix ("funds" or "error", whose words say nothing
    // was sent): the "?" entry may still be there, and the settling would send the same request again.
    is("the press says the batch may still go", refused.ok ? "paid" : refused.reason, "pending");
    // Rule 23: new assertion, red before the fix (the "funds" email says "Nothing left your PayPal").
    is("and the payday email never says nothing left the creator's PayPal", autoPayEmail(refused, "usd").text.includes("Nothing left your PayPal"), false);
    is("its people stay on their way, never put in another batch", (await onTheirWay(store)).size, 2);
  }

  part("PayPal refuses the batch, and taking the \"?\" entry away is confirmed: its people are owed again");
  await seed(store);
  refuseNext = true;
  const owedAgain = await payWithPayPal(store);
  is("the press says why", owedAgain.ok ? "paid" : owedAgain.reason, "funds");
  is("nothing stays open", await openFields(), []);
  await settlePayPal(store);
  is("and the settling sends nothing more", posts, 1);

  done();
}

void main();
