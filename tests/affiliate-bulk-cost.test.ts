/**
 * What a change in bulk reads and writes, measured, and paid for in studio requests before it is done (pre-review of
 * claude5/affiliate-cap-writes, MEDIUM 2). Synthetic only: the in-memory Redis double, through the real route
 * app/api/store/affiliates/route.ts, in a program of 1,000 records.
 *
 * Before: each person of a bulk change that raised a share (or approved a share) took the partner lock, read the store
 * and the whole program (HGETALL) on its own: 100 people, 100 HGETALLs of 1,000 records, all inside the one studio
 * request the press took.
 *
 * Now: one read of the people asked for (HMGET), one partner lock, one read of the store and at most one HGETALL for
 * the whole batch, checked against the cap at once; and the batch takes, before each part, the studio requests that
 * part costs at its worst size (lib/affiliates.ts bulkUnits), so what every command and byte measured here costs, at
 * a studio request's shape and the prices of tests/plan-cost-registry.ts, is inside the studio requests taken. Each
 * part is taken at its worst before it is read and given back, once read, down to its measured size rounded up, so
 * the store keeps paying only for what was really read (coordinator's decision of 2026-11-07).
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { AFFILIATE_RECORD_MAX_BYTES, MAX_NOTE_LENGTH, bulkUnits, readAffiliate } from "@/lib/affiliates";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { allowanceUsed } from "@/lib/store-allowance";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;


const real = redis.pipeline.bind(redis);
const seen = { commands: 0, bytes: 0, hgetall: 0, lockTakes: 0 };
let measuring = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (measuring) {
    seen.commands += commands.length;
    seen.bytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies));
    for (const command of commands) {
      if (command[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(command[1]))) seen.hgetall += 1;
      if (command[0] === "SET" && /:partners:lock$/.test(String(command[1]))) seen.lockTakes += 1;
    }
  }
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "glazier@example.com";
  await claimHandle(owner, "glaziershop", "Glazier store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1glaziersh5808", true);
  await setSubscription(owner, { customerId: "cus_glazier", subscriptionId: "sub_glazier", active: true, tier: "scale", period: paidPeriod() });
  const p = await addProduct(owner, "Glass Course", "", "40");
  const q = await addProduct(owner, "Kiln Course", "", "40");
  const P = p.ok ? p.product.id : "";
  const Q = q.ok ? q.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const people = `nl:aff:${(await store()).statsId}:people`;
  const note = "I share it with my readers every week, in a long post and a short video, and in my newsletter. ".repeat(3).slice(0, 200);
  const id = (n: number) => n.toString(16).padStart(12, "0");
  const person = (n: number, status: string, share: { percent: number; products: string[] } | null) =>
    JSON.stringify({ id: id(n), email: `person${n}@example.com`, code: `c${n}`, status, appliedAt: n, decidedAt: n, note, rate: null, paypal: "", share, cleared: null, by: null });
  // 100 approved affiliates to change, one partner with 50% of the glass course, 100 waiting with 9% of the kiln
  // course each, and 799 more: 1,000 records.
  const targets = Array.from({ length: 100 }, (_, i) => i);
  const sharers = Array.from({ length: 100 }, (_, i) => 101 + i);
  const writes: (string | number)[][] = [];
  for (const n of targets) writes.push(["HSET", people, id(n), person(n, "approved", null)]);
  writes.push(["HSET", people, id(100), person(100, "approved", { percent: 50, products: [P] })]);
  for (const n of sharers) writes.push(["HSET", people, id(n), person(n, "pending", { percent: 9, products: [Q] })]);
  for (let n = 201; n < 1000; n += 1) writes.push(["HSET", people, id(n), person(n, n % 2 ? "approved" : "removed", null)]);
  await real(writes);
  is("(1,000 records)", Number((await real([["HLEN", people]]))[0]), 1000);

  part("0. The widest record a program can keep fits the size a batch pays for each");
  const wide = "\u0001".repeat(MAX_EMAIL_LENGTH - 12);
  const widest = {
    id: "fffffffffff0",
    email: `${wide}@example.com`,
    code: "z".repeat(20),
    status: "approved",
    appliedAt: Number.MAX_SAFE_INTEGER,
    decidedAt: Number.MAX_SAFE_INTEGER,
    note: "\u0001".repeat(MAX_NOTE_LENGTH),
    rate: 90,
    paypal: `${wide}@example.org`,
    share: { percent: 80, products: Array.from({ length: 200 }, (_, i) => `${"q".repeat(36)}${String(i).padStart(4, "0")}`) },
    cleared: { paid: Number.MAX_SAFE_INTEGER, with: Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(12, "a")) },
    by: { id: "fffffffffff1", percent: 90 },
    warned: Number.MAX_SAFE_INTEGER,
  };
  await real([["HSET", people, widest.id, JSON.stringify(widest)]]);
  const kept = await readAffiliate(await store(), widest.id);
  const keptBytes = Buffer.byteLength(JSON.stringify({ ...kept, decidedAt: Number.MAX_SAFE_INTEGER }));
  console.log(`  the widest record: ${keptBytes} bytes`);
  is("read back whole (its share, its addresses)", [kept?.share?.products.length, kept?.cleared?.with.length, kept?.email.length], [200, 50, MAX_EMAIL_LENGTH]);
  is("no more than AFFILIATE_RECORD_MAX_BYTES as written", keptBytes <= AFFILIATE_RECORD_MAX_BYTES, true);
  await real([["HDEL", people, widest.id]]);

  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const measured = async (label: string, body: Record<string, unknown>) => {
    const used = await allowanceUsed(await store(), "studio");
    Object.assign(seen, { commands: 0, bytes: 0, hgetall: 0, lockTakes: 0 });
    measuring = true;
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    measuring = false;
    const answer = (await response.json()) as { ok?: boolean; before?: unknown[]; refused?: { why: string }[]; held?: { why: string }[]; undone?: number };
    const units = (await allowanceUsed(await store(), "studio")) - used;
    console.log(`  ${label}: ${seen.commands} commands, ${seen.bytes} bytes, ${seen.hgetall} HGETALL, ${seen.lockTakes} lock takes; ${units} studio requests taken`);
    is(`${label}: at most one read of the whole program`, seen.hgetall <= 1, true);
    is(`${label}: at most one partner lock taken`, seen.lockTakes <= 1, true);
    is(`${label}: every command and byte inside the studio requests taken first`, request("studio", seen.commands, seen.bytes) <= units * UNIT_COST.studio, true);
    // Taken at the worst before each read, then given back down to what was really read (coordinator, 2026-11-07):
    // at most what was measured, rounded up once for each part the batch holds for (four).
    is(`${label}: no more kept than what was measured, rounded up`, units <= bulkUnits(seen.commands, seen.bytes) + 4, true);
    return { status: response.status, answer };
  };
  const rateOf = async (n: number) => (await readAffiliate(await store(), id(n)))?.rate;
  const statusOf = async (n: number) => (await readAffiliate(await store(), id(n)))?.status;

  part("1. 100 shares raised at once to 30% (the partner's 50 + 30 = 80%)");
  const raised = await measured("raise", { action: "bulk-rate", ids: targets.map(id), rate: 30 });
  is("all 100 changed, none refused", [raised.status, raised.answer.before?.length, raised.answer.refused], [200, 100, []]);
  is("each at 30%", (await Promise.all(targets.map(rateOf))).every((rate) => rate === 30), true);

  part("2. The undo: back to the program's 5%, which pays less everywhere");
  const before = targets.map((n) => ({ id: id(n), rate: null }));
  const undone = await measured("undo", { action: "bulk-rate-undo", before, rate: 30 });
  is("all 100 put back", [undone.status, undone.answer.undone], [200, 100]);
  is("each on the program's share", (await Promise.all(targets.map(rateOf))).every((rate) => rate === null), true);

  part("3. 100 applications with 9% of the kiln course each, approved at once (5% to affiliates)");
  const approved = await measured("approve", { action: "bulk", decision: "approve", ids: sharers.map(id) });
  const held = approved.answer.held ?? [];
  is("9 approved (81 + 5 = 86%), 91 left waiting by the cap", [approved.status, approved.answer.before?.length, held.length, held.every((h) => h.why === "cap")], [200, 9, 91, true]);
  is("as written", (await Promise.all(sharers.map(statusOf))).filter((s) => s === "approved").length, 9);
  done();
}
main();
