/**
 * Issue #4479 (Codex X8): "Mark the batch as paid" (POST app/api/store/affiliates/payout-batch) took only a date and a
 * reference and wrote down whatever the book owed when it was pressed. An affiliate who became owed after the file was
 * downloaded, or a larger amount than the file's, was then recorded as paid although the paid file never held them.
 *
 * The confirmation is now tied to the file: the download (GET) leaves a signed print of its exact lines (who and how
 * much) in a cookie, and the confirmation writes the batch only when the book still owes exactly those lines. Any
 * difference, a missing print, an expired one or another store's, writes nothing and says so.
 *
 * Synthetic: Redis stub, Stripe answered by a stand-in, the signed-in owner from the two world files.
 */
import type { NextRequest } from "next/server";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { GET, POST } from "@/app/api/store/affiliates/payout-batch/route";
import { who } from "./affiliate-payout-batch-route-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_batch_matches_file_only";
process.env.RESEND_API_KEY = "re_test_payout_batch_matches_file_only";

const OWNER = "miller@example.com";
const NOW = Math.floor(Date.now() / 1000);
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string) =>
  JSON.stringify({ id, email: `${id.slice(0, 1)}.payee@example.com`, code: id.slice(0, 3), status: "approved", appliedAt: (NOW - 90 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string, aff: string, base: number, daysAgo = 60) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - daysAgo * 86_400, product: "prod01", title: "Flour course", base, total: base, currency: "usd", rate: 50, self: false, how: "click" });

async function download(): Promise<{ status: number; cookie: string }> {
  const response = await GET(new Request("https://local.example/api/store/affiliates/payout-batch") as unknown as NextRequest);
  await response.text();
  const set = response.headers.get("set-cookie") ?? "";
  return { status: response.status, cookie: set.split(";")[0] ?? "" };
}
async function confirm(cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await POST(new Request("https://local.example/api/store/affiliates/payout-batch", { method: "POST", headers, body: JSON.stringify({ date: "2026-11-13", reference: "Wise batch 7" }) }) as unknown as NextRequest);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const paid = async (statsId: string) => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:aff:${statsId}:payouts`]]);
  const flat = Array.isArray(raw) ? (raw as string[]) : [];
  const rows: [string, number][] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const p = JSON.parse(flat[i]) as { aff: string; cents: number };
    rows.push([p.aff, p.cents]);
  }
  return rows.sort();
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mill", "Stone Mill", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBatchFile", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 50 });
  const store = (await storeForEmail(OWNER))!;
  who.store = store;
  const sid = store.statsId!;
  const reset = async () => {
    redis.clear();
    await claimHandle(OWNER, "mill", "Stone Mill", "");
    await ensureStatsId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestBatchFile", true);
    await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 50 });
    who.store = (await storeForEmail(OWNER))!;
  };
  const people = async (...ids: string[]) =>
    redis.pipeline(ids.flatMap((id) => [["HSET", `nl:aff:${who.store!.statsId}:people`, id, person(id)], ["HSET", `nl:aff:${who.store!.statsId}:codes`, id.slice(0, 3), id]]));
  const sell = async (ref: string, aff: string, base: number, daysAgo = 60) => redis.pipeline([["HSET", `nl:aff:${who.store!.statsId}:sales`, ref, sale(ref, aff, base, daysAgo)]]);

  part("Control: the book unchanged since the download");
  await people(A, B);
  await sell("cs_a1", A, 1_000);
  const file = await download();
  is("the file is handed out, with its print", [file.status, file.cookie.startsWith("nl_aff_batch=")], [200, true]);
  const fine = await confirm(file.cookie);
  is("written as the file says: A $5.00, nobody else", [fine.status, await paid(sid)], [200, [[A, 500]]]);

  part("An affiliate who became owed after the file was issued");
  await reset();
  await people(A, B);
  await sell("cs_a1", A, 1_000);
  const early = await download();
  await sell("cs_b1", B, 1_400);
  const late = await confirm(early.cookie);
  is("nothing is written, and the answer says the batch changed", [late.status, late.body.error, await paid(who.store!.statsId!)], [409, "changed", []]);

  part("Only A's own amount grew after the file was issued");
  await reset();
  await people(A);
  await sell("cs_a1", A, 1_000);
  const small = await download();
  await sell("cs_a2", A, 600);
  const grown = await confirm(small.cookie);
  is("nothing is written for $8.00 against a paid file of $5.00", [grown.status, grown.body.error, await paid(who.store!.statsId!)], [409, "changed", []]);

  part("No print, a tampered one or an expired one");
  const none = await confirm("");
  is("no file downloaded here: nothing written", [none.status, none.body.error, await paid(who.store!.statsId!)], [409, "no_file", []]);
  const [exp, sig] = small.cookie.slice("nl_aff_batch=".length).split(".");
  const tampered = await confirm(`nl_aff_batch=${Number(exp) + 86_400}.${sig}`);
  is("a print whose time was changed: nothing written", [tampered.status, tampered.body.error], [409, "changed"]);
  const old = await confirm(`nl_aff_batch=${NOW - 60}.${sig}`);
  is("an expired print: nothing written", [old.status, old.body.error], [409, "no_file"]);
  const fresh = await download();
  const again = await confirm(fresh.cookie);
  is("downloaded again, the file is written as it now stands: A $8.00", [again.status, await paid(who.store!.statsId!)], [200, [[A, 800]]]);

  done();
}

void main();
