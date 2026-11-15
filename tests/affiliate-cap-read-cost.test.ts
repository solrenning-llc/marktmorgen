/**
 * The single studio actions that read the whole affiliate program to check the 90% cap pay for that read before it
 * is made, and keep paying only what it really read (coordinator, 2026-11-07, rule 30). Synthetic only: the
 * in-memory Redis double, through the real route app/api/store/affiliates/route.ts, in a program of 1,000 records.
 *
 * Before: raising one affiliate's share, setting a partner's share, approving somebody who holds a share and raising
 * the program's commission each read every record of the program (HGETALL, up to ~45 MB) inside the one studio
 * request the press took: a cost with no ceiling.
 *
 * Now: the people are counted (HLEN), the studio requests their read costs at its worst (lib/affiliates.ts
 * bulkUnits, AFFILIATE_RECORD_MAX_BYTES a record) are taken before it, and once read, what it did not need is given
 * back: the store pays the measured read, rounded up. With too few requests left, nothing is read or written: 429.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { bulkUnits, readAffiliate } from "@/lib/affiliates";
import { MAX_NOTE_LENGTH } from "@/lib/affiliates";
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
const seen = { commands: 0, bytes: 0, hgetall: 0 };
let measuring = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (measuring) {
    seen.commands += commands.length;
    seen.bytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies));
    for (const command of commands) if (command[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(command[1]))) seen.hgetall += 1;
  }
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "turner@example.com";
  await claimHandle(owner, "turnershop", "Turner store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1turnershoc531", true);
  await setSubscription(owner, { customerId: "cus_turner", subscriptionId: "sub_turner", active: true, tier: "scale", period: paidPeriod() });
  const p = await addProduct(owner, "Lathe Course", "", "40");
  const q = await addProduct(owner, "Bowl Course", "", "40");
  const P = p.ok ? p.product.id : "";
  const Q = q.ok ? q.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const people = `nl:aff:${(await store()).statsId}:people`;
  // A note of control characters: the widest a note is read as (six bytes each in the record, seven in the reply).
  const note = "\u0001".repeat(MAX_NOTE_LENGTH);
  const id = (n: number) => n.toString(16).padStart(12, "0");
  const person = (n: number, status: string, share: { percent: number; products: string[] } | null) =>
    JSON.stringify({ id: id(n), email: `person${n}@example.com`, code: `c${n}`, status, appliedAt: n, decidedAt: n, note, rate: null, paypal: "", share, cleared: null, by: null });
  const writes: (string | number)[][] = [["HSET", people, id(1), person(1, "approved", { percent: 50, products: [P] })]];
  writes.push(["HSET", people, id(2), person(2, "approved", null)]);
  writes.push(["HSET", people, id(3), person(3, "approved", null)]);
  writes.push(["HSET", people, id(4), person(4, "pending", { percent: 5, products: [Q] })]);
  for (let n = 5; n <= 1000; n += 1) writes.push(["HSET", people, id(n), person(n, n % 2 ? "approved" : "removed", null)]);
  await real(writes);

  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const measured = async (label: string, body: Record<string, unknown>) => {
    const used = await allowanceUsed(await store(), "studio");
    Object.assign(seen, { commands: 0, bytes: 0, hgetall: 0 });
    measuring = true;
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    measuring = false;
    const answer = (await response.json()) as { ok?: boolean; error?: string };
    const units = (await allowanceUsed(await store(), "studio")) - used;
    console.log(`  ${label}: ${seen.commands} commands, ${seen.bytes} bytes, ${seen.hgetall} HGETALL; ${units} studio requests kept`);
    is(`${label}: saved`, [response.status, answer.ok], [200, true]);
    is(`${label}: the program read once`, seen.hgetall, 1);
    is(`${label}: every command and byte inside the studio requests taken first`, request("studio", seen.commands, seen.bytes) <= units * UNIT_COST.studio, true);
    is(`${label}: no more kept than what was measured, rounded up`, units <= bulkUnits(seen.commands, seen.bytes) + 2, true);
  };

  part("1. Raising one affiliate's own share (5% to 30%; the partner's 50 + 30 = 80%)");
  await measured("rate", { action: "rate", id: id(2), rate: 30 });
  is("as asked", (await readAffiliate(await store(), id(2)))?.rate, 30);

  part("2. Setting a partner's share");
  await measured("share", { action: "share", id: id(3), percent: 10, products: [Q] });
  is("as asked", (await readAffiliate(await store(), id(3)))?.share, { percent: 10, products: [Q] });

  part("3. Approving somebody who holds a share");
  await measured("approve", { action: "approve", id: id(4) });
  is("as asked", (await readAffiliate(await store(), id(4)))?.status, "approved");

  part("4. Raising the program's commission (5% to 6%)");
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 6, days: 60, rates: {} as Record<string, number> };
  await measured("settings", terms);
  is("as asked", (await store()).affiliates.percent, 6);
  done();
}
main();
