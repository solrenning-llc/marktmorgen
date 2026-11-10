/**
 * A PayPal payout batch whose creation answer is not known (CX-123 rule 24,
 * Claude 5, 05/11/2026). The POST that sends the creator's money may have
 * made the batch even when its answer is unreadable, never comes (the line
 * dropped or the wait ran out) or is a server error. Such a press must leave
 * every affiliate in it "on their way", so the next press, payday or payout
 * file never pays them again; only an answer that says PayPal refused the
 * batch (a 4xx with PayPal's own error name) leaves them owed.
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com.
 */
import { readFileSync } from "node:fs";
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { autoPayEmail } from "@/lib/affiliate-payday";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsunk01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
type Mode = "ok" | "garbled" | "empty" | "no-id" | "dropped" | "server" | "funds" | "nameless" | "blank-name" | "blank-error";
let mode: Mode = "ok";
let made = 0;
let reads = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    if (mode === "funds") return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    // A 4xx without PayPal's own error name (review of Codex G on #2681): not PayPal's refusal, so not known.
    if (mode === "nameless") return new Response("Bad Request", { status: 400 });
    // A name that is empty or only spaces is no name (review of Codex G on #2681, 4725f07a).
    if (mode === "blank-name") return json({ name: "   ", message: "?" }, 400);
    if (mode === "blank-error") return json({ error: "" }, 400);
    // Every other mode: PayPal made the batch, the creator's money is leaving.
    made += 1;
    const id = `BATCH${made}ABC`;
    if (mode === "garbled") return new Response("<html>upstream</html>", { status: 201 });
    if (mode === "empty") return new Response("", { status: 201 });
    if (mode === "no-id") return json({ batch_header: { batch_status: "PENDING" } }, 201);
    if (mode === "dropped") throw new TypeError("fetch failed: the connection was reset");
    if (mode === "server") return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    return json({ batch_header: { payout_batch_id: id, batch_status: "PENDING" } }, 201);
  }
  if (url.pathname.startsWith("/v1/payments/payouts/")) reads += 1;
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidunknown01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
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

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_unknown_only";
  console.error = () => {};
  const store = shop();

  for (const unknown of ["garbled", "empty", "no-id", "dropped", "server"] as const) {
    part(`A batch made, its answer ${unknown}: nobody in it is paid twice`);
    await seed(store);
    made = 0;
    mode = unknown;
    const first = await payWithPayPal(store);
    is("the press is not reported as paid", first.ok, false);
    is("PayPal made one batch", made, 1);
    is("both affiliates stay on their way", [...(await onTheirWay(store))].sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    mode = "ok";
    const second = await payWithPayPal(store);
    is("a second press sends no new batch", made, 1);
    is("and says there is nothing to pay now", second.ok ? "paid" : second.reason, "nothing");
  }

  part("The daily settling leaves a batch whose answer is not known on its way, and asks PayPal nothing about it");
  await seed(store);
  made = 0;
  mode = "dropped";
  await payWithPayPal(store);
  reads = 0;
  const settled = await settlePayPal(store);
  is("both still waiting, no read of a batch id PayPal never gave", [settled.waiting, settled.paid, settled.released, reads], [2, 0, 0, 0]);
  is("and still on their way", (await onTheirWay(store)).size, 2);

  part("What the creator is told never says nothing was sent");
  const email = autoPayEmail({ ok: false, reason: "unknown" }, "usd");
  is("the payday email says it is not known, and to look at PayPal", [email.text.includes("Nothing left your PayPal"), email.text.includes("we do not know whether it was paid"), email.text.includes("PayPal activity")], [false, true, true]);
  const studioWords = /unknown: "([^"]+)"/.exec(readFileSync("components/paypal-payouts.tsx", "utf8"))?.[1] ?? "";
  is("the studio's words for it", [studioWords.includes("Nothing was sent"), studioWords.includes("we do not know whether it was paid"), studioWords.includes("PayPal activity")], [false, true, true]);

  for (const blank of ["nameless", "blank-name", "blank-error"] as const) {
    part(`A 4xx without PayPal's own error name (${blank}) is not a refusal: kept on its way`);
    await seed(store);
    made = 0;
    mode = blank;
    const nameless = await payWithPayPal(store);
    is("unknown, never 'nothing was sent'", nameless.ok ? "paid" : nameless.reason, "unknown");
    is("both stay on their way", (await onTheirWay(store)).size, 2);
  }

  for (const fault of ["no answer", "an error"] as const) {
    part(`PayPal made the batch, and writing its id got ${fault}: nobody is paid twice (review of Codex G on #2681, GRAVE)`);
    await seed(store);
    made = 0;
    mode = "ok";
    const real = redis.pipeline.bind(redis);
    let hit = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = commands[0];
      if (!hit && first?.[0] === "HSET" && first[1] === "nl:pp:open:statsunk01" && !String(first[2]).startsWith("?")) {
        hit = true;
        // As Codex G's proof: the write of the id fails, and any HDEL sent with it in the same pipeline still runs.
        const removed = await real(commands.filter((c) => c[0] === "HDEL"));
        if (fault === "an error") throw new Error("Synthetic: the write of the batch's id failed, the HDEL beside it ran");
        return [undefined, ...removed];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await payWithPayPal(store);
    } finally {
      redis.pipeline = real;
    }
    is("the write of its id failed", hit, true);
    is("both stay on their way", (await onTheirWay(store)).size, 2);
    await payWithPayPal(store);
    is("a second press sends no new batch", made, 1);
  }

  part("A batch PayPal refused by name (insufficient funds): owed, paid on the next press");
  await seed(store);
  made = 0;
  mode = "funds";
  const refused = await payWithPayPal(store);
  is("refused for funds", refused.ok ? "paid" : refused.reason, "funds");
  is("nobody is on their way", (await onTheirWay(store)).size, 0);
  mode = "ok";
  const paid = await payWithPayPal(store);
  is("the next press pays both, once", [paid.ok, made, paid.ok ? paid.people : 0], [true, 1, 2]);
  is("both on their way under the real batch", (await onTheirWay(store)).size, 2);

  done();
}

void main();
