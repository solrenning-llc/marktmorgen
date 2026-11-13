/**
 * #4479 (HIGH, money; Codex X8 report of 13/11/2026 06:57): the payout batch file (GET) lists who the book says can
 * be paid when it is downloaded; "I have paid this batch" (POST) took only a date and a reference and wrote down
 * whatever the book said when it was pressed. An affiliate who became payable after the file was issued was written
 * down as paid without being in the paid file (and may then leave the next file unpaid), and an affiliate whose own
 * amount grew was written down for more than the file paid.
 *
 * The fix ties the file and its confirmation to the batch the studio page showed: its id (batchId, over every
 * affiliate id and amount in the file) goes with the download and with the confirmation, and each half refuses when
 * the book no longer comes to that batch, writing nothing down for anyone. Checked through the real GET and POST of
 * app/api/store/affiliates/payout-batch over the Redis stub, Stripe answered by a synthetic fetch, the signed-in
 * creator from tests/payout-batch-confirm-exact-world.ts:
 *
 *   - control: the book unchanged since the page: the file lists A at $5.00 and the confirmation writes A for 500;
 *   - B payable after the file was issued: the confirmation writes nobody down, and says the book changed;
 *   - only A's own amount grew after the file: nobody is written down for the $8.00 the file never paid;
 *   - a download for a batch the book no longer comes to: refused, no affiliate address or amount in it;
 *   - a confirmation with no batch named: refused, nothing written;
 *   - the same batch confirmed twice: one payout, never two.
 */
import type { NextRequest } from "next/server";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { readBook } from "@/lib/affiliates";
import * as payouts from "@/lib/affiliate-payouts";
import { onTheirWay, payableLines } from "@/lib/paypal-payouts";
import { GET, POST } from "@/app/api/store/affiliates/payout-batch/route";
import { who } from "./payout-batch-confirm-exact-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_confirm_only";
process.env.RESEND_API_KEY = "re_test_payout_batch_confirm_only";

const OWNER = "miller@example.com";
const NOW = Math.floor(Date.now() / 1000);
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const A_EMAIL = "ana.payee@example.com";
const B_EMAIL = "bea.payee@example.com";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 90 * 86_400) * 1000, decidedAt: 1, note: "" });
// 30% of `base`: a $50.00 sale is $15.00 of commission; base 1_667 is $5.00 (rounded), base 1_000 is $3.00.
const sale = (ref: string, aff: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 60 * 86_400, product: "prod01", title: "Rye course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });

// The batch the studio page shows (app/studio/affiliates/page.tsx): its id, from the real book, or "none" on a
// main without batchId, which then confirms whatever it is sent.
async function pageBatch(store: Store): Promise<string> {
  const book = await readBook(store, undefined, { titles: false });
  const lines = payableLines(book, await onTheirWay(store));
  const id = (payouts as { batchId?: (lines: unknown) => string }).batchId;
  return typeof id === "function" ? id(lines) : "none";
}
const download = async (batch: string) => {
  const response = await GET(new Request(`https://local.example/api/store/affiliates/payout-batch?provider=worksheet&batch=${encodeURIComponent(batch)}`) as unknown as NextRequest);
  return { status: response.status, body: await response.text() };
};
const confirm = async (body: Record<string, unknown>) => {
  who.body = body;
  const response = await POST(new Request("https://local.example/api/store/affiliates/payout-batch", { method: "POST" }) as unknown as NextRequest);
  return { status: response.status, json: (await response.json()) as { ok?: boolean; error?: string; written?: number } };
};
async function written(statsId: string): Promise<[string, number][]> {
  const all = (await redis.pipeline([["HGETALL", `nl:aff:${statsId}:payouts`]]))[0] as unknown;
  const flat = Array.isArray(all) ? (all as string[]) : Object.entries((all ?? {}) as Record<string, string>).flat();
  const out: [string, number][] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const payout = JSON.parse(flat[i]!) as { aff: string; cents: number };
    out.push([payout.aff, payout.cents]);
  }
  return out.sort();
}

async function freshStore(): Promise<{ store: Store; statsId: string }> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Mill", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBatchConfirm", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  who.store = store;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, A, person(A, A_EMAIL, "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", A],
    ["HSET", `nl:aff:${statsId}:emails`, A_EMAIL, A],
    ["HSET", `nl:aff:${statsId}:people`, B, person(B, B_EMAIL, "bea")],
    ["HSET", `nl:aff:${statsId}:codes`, "bea", B],
    ["HSET", `nl:aff:${statsId}:emails`, B_EMAIL, B],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_a1", sale("cs_a1", A, 1_667)],
  ]);
  return { store, statsId };
}

async function main(): Promise<void> {
  part("Control: the book unchanged since the page");
  {
    const { store, statsId } = await freshStore();
    const batch = await pageBatch(store);
    const file = await download(batch);
    is("the file is handed out", file.status, 200);
    is("it lists only A, $5.00", [file.body.includes(A_EMAIL), file.body.includes("5.00"), file.body.includes(B_EMAIL)], [true, true, false]);
    const paid = await confirm({ date: "2026-11-13", reference: "Wise 1", batch });
    is("the confirmation is taken", [paid.status, paid.json.ok, paid.json.written], [200, true, 1]);
    is("A is written down for 500, nobody else", await written(statsId), [[A, 500]]);
  }

  part("An affiliate who became payable after the file was issued");
  {
    const { store, statsId } = await freshStore();
    const batch = await pageBatch(store);
    const file = await download(batch);
    is("the file lists A only", [file.status, file.body.includes(A_EMAIL), file.body.includes(B_EMAIL)], [200, true, false]);
    await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_b1", sale("cs_b1", B, 2_334)]]);
    const paid = await confirm({ date: "2026-11-13", reference: "Wise 2", batch });
    is("the confirmation is refused: the book changed since the file", [paid.status, paid.json.ok, paid.json.error], [409, false, "changed"]);
    is("nobody is written down: B was not in the file", await written(statsId), []);
  }

  part("Only A's own amount grew after the file was issued");
  {
    const { store, statsId } = await freshStore();
    const batch = await pageBatch(store);
    is("the file lists $5.00", (await download(batch)).body.includes("5.00"), true);
    await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_a2", sale("cs_a2", A, 1_000)]]);
    const paid = await confirm({ date: "2026-11-13", reference: "Wise 3", batch });
    is("the confirmation is refused: the book changed since the file", [paid.status, paid.json.error], [409, "changed"]);
    is("A is not written down for the $8.00 the file never paid", await written(statsId), []);
  }

  part("A download for a batch the book no longer comes to");
  {
    const { store, statsId } = await freshStore();
    const batch = await pageBatch(store);
    await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_b1", sale("cs_b1", B, 2_334)]]);
    const file = await download(batch);
    is("refused, not a file to pay from", file.status, 409);
    is("no affiliate address or amount in the answer", [file.body.includes(A_EMAIL), file.body.includes(B_EMAIL), file.body.includes("5.00")], [false, false, false]);
  }

  part("A confirmation that names no batch");
  {
    const { statsId } = await freshStore();
    const paid = await confirm({ date: "2026-11-13", reference: "Wise 4" });
    is("refused", [paid.status, paid.json.ok, paid.json.error], [400, false, "batch"]);
    is("nothing written down", await written(statsId), []);
  }

  part("The same batch confirmed twice");
  {
    const { store, statsId } = await freshStore();
    const batch = await pageBatch(store);
    is("first time: written", (await confirm({ date: "2026-11-13", reference: "Wise 5", batch })).json.written, 1);
    const again = await confirm({ date: "2026-11-13", reference: "Wise 5", batch });
    is("second time: refused, nothing new", [again.status, again.json.ok], [409, false]);
    is("one payout, never two", await written(statsId), [[A, 500]]);
  }

  done();
}

void main();
