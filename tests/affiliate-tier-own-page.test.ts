/**
 * An affiliate's own page shows the second tier the creator's book owes them.
 *
 * tierLines keeps everything promised on one sale (the recruit's share, the
 * second tier and every partner's share) under the program's cap. readBook for
 * one affiliate (their own page, lib/affiliate-page-admission.ts ownBook) read
 * only that affiliate's partner shares, so the partners' shares of a recruit's
 * sale were missing there and the second tier came out larger than in the
 * creator's book: a 60% recruit sale with a 25% partner and a 10% second tier
 * owes 5% (90 - 60 - 25), but the recruiter's page said 10%, with owed and
 * payable to match.
 */
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid9";
const UP = "0123456789aa";
const RECRUIT = "0123456789bb";
const PARTNER = "0123456789cc";

function shop(): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 20, days: 30, rates: {}, payday: 0, hold: 0 },
  } as unknown as Store;
}

const person = (id: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email: `${code}@example.com`, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "", ...over });

async function main(): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 3600;
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, UP, person(UP, "upper"), RECRUIT, person(RECRUIT, "recruit", { by: { id: UP, percent: 10 } }), PARTNER, person(PARTNER, "partner", { share: { percent: 25, products: ["course"] } })],
    ["HSET", `nl:aff:${STATS}:codes`, "upper", UP, "recruit", RECRUIT, "partner", PARTNER],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_one", JSON.stringify({ ref: "cs_one", pi: "pi_one", aff: RECRUIT, at, product: "course", title: "Course", base: 10_000, total: 10_000, currency: "usd", rate: 60, self: false, how: "click" })],
    ["HSET", `nl:aff:${STATS}:shares`, `cs_one:${PARTNER}`, JSON.stringify({ ref: "cs_one", pi: "pi_one", aff: PARTNER, at, product: "course", title: "Course", base: 10_000, total: 10_000, currency: "usd", percent: 25, self: false })],
  ]);
  const tier = (lines: { aff: string; how: string; rate: number; commission: number }[]) =>
    lines.filter((l) => l.aff === UP && l.how === "tier2").map((l) => [l.rate, l.commission]);
  const whole = await readBook(shop());
  is("the creator's book: 90 - 60 - 25 leaves 5%", tier(whole.lines), [[5, 500]]);
  const own = await readBook(shop(), UP);
  is("the recruiter's own page owes the same", tier(own.lines), [[5, 500]]);
  is("and only their own lines are shown", own.lines.every((l) => l.aff === UP), true);
  is("owed matches the book", own.rows.find((r) => r.affiliate.id === UP)?.owed, whole.rows.find((r) => r.affiliate.id === UP)?.owed);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
