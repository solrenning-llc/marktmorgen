/**
 * A removed product's waitlist that could not be dropped is still reached, and never outlives an erasure that answers
 * done (#4462 reviews: Codex X8 MÉDIO, Claude 7 MÉDIO 1-4 and 8, LEVE 5; 16 November 2026).
 *
 * 1. A product taken off coming soon (or launched) and then removed, whose drop failed, kept its addresses with no
 *    catalog entry and no mark: an erasure answered done and left them. Now the product is noted as dropping before it
 *    goes, the note stays until the drop is confirmed, the route says cleanupPending, and asking again finishes it.
 * 2. A join that passed its coming-soon check before the product was removed wrote its address after the drop. Now
 *    the drop unmarks first and the join's write is fenced by the mark in one script.
 * 3. A three-key DEL that answered 4 was taken as done. Each reply is now held to its range.
 * 4. An erasure walked every coming-soon mark without counting it. The marks are now counted in its size, capped, and
 *    an oversized set is unknown.
 * 5. The drop and the hold are paid before anything goes (WAITLIST_DROP_UNITS), and the drop gives back the waitlist's
 *    data room.
 *
 * Synthetic Redis only; no provider is called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { erasePerson, erasureScope, erasureSize } from "@/lib/person-erasure";
import { ERASE_PER, UNIT_BYTES, UNIT_COMMANDS, erasureWork } from "@/lib/erasure-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { allowanceUsedExact, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { dataKey } from "@/lib/store-data";
import * as waitlist from "@/lib/waitlist";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const owner = "waitlist-pending-owner@example.test";
const person = "waitlist-pending-person@example.test";
const other = "waitlist-pending-other@example.test";
const named = waitlist as unknown as Record<string, unknown>;
type Pipeline = typeof redis.pipeline;

async function world(opts: { soon: boolean }) {
  redis.clear();
  await claimHandle(owner, "wlpending", "Waitlist Pending", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_WlPending", subscriptionId: "sub_WlPending", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic coming soon", "", "27", null);
  assert.ok(made.ok);
  const shop = (await storeForEmail(owner))!;
  const sid = shop.statsId!;
  const pid = made.product.id;
  await waitlist.setSoon(shop, pid, true);
  const entry = (at: number) => JSON.stringify({ at, ok: at, c: false, t: "0".repeat(48) });
  redis.run(["HSET", `nl:wl:${sid}:${pid}`, person, entry(1), other, entry(2)]);
  redis.run(["HSET", dataKey(shop)!, `wl:${pid}`, "400"]);
  // Taken off coming soon without a launch: the mark goes, the addresses stay (Codex X8's case).
  if (!opts.soon) await waitlist.setSoon(shop, pid, false);
  return { shop, sid, pid, made: made.product };
}

async function remove(id: string) {
  const session = await openSession(owner);
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/product", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "remove", id }),
  }));
  return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; cleanupPending?: boolean } };
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  console.error = () => {};
  try { return await run(); } finally { globalThis.fetch = oldFetch; console.error = oldLog; }
}

test("a removal that needs two fixed studio units never consumes the last one before refusing", async () => {
  await quiet(async () => {
    const { shop, sid, pid } = await world({ soon: true });
    const at = Date.now();
    const limit = allowanceFor(shop, "studio", at / 1000);
    const used = await allowanceUsedExact(shop, "studio", at);
    assert.notEqual(used, null, "the fixture's studio count reads exactly");
    const fill = limit - 1 - (used ?? 0);
    assert.ok(fill > 0, "the fixture has room to leave one request");
    assert.equal((await takeAllowance(shop, "studio", fill, at)).ok, true);

    const refused = await remove(pid);
    assert.equal(refused.status, 429, "one unit cannot admit two fixed units");
    assert.equal(await allowanceUsedExact(shop, "studio", at), limit - 1, "the refused compound admission consumes none of the last unit");
    assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 1, "the waitlist stays reachable while the product stays");
    assert.equal(redis.run(["SISMEMBER", `nl:wl:${sid}:soon`, pid]), 1);
  });
});

async function leaveStudio(shop: Awaited<ReturnType<typeof world>>["shop"], left: number, at: number): Promise<number> {
  const limit = allowanceFor(shop, "studio", at / 1000);
  const used = await allowanceUsedExact(shop, "studio", at);
  assert.notEqual(used, null, "the fixture's studio count reads exactly");
  const fill = limit - left - (used ?? 0);
  assert.ok(fill > 0, `the fixture has room to leave ${left} requests`);
  assert.equal((await takeAllowance(shop, "studio", fill, at)).ok, true);
  return limit;
}

test("a removal never spends the request, the waitlist's unit or the invitations' first unit before one of them refuses (Codex P on #4462)", async () => {
  await quiet(async () => {
    // Two left: the request and the waitlist's unit fit, the invitations' first page (lib/move-members.ts
    // notePendingInvites) does not. Nothing may be spent, and nothing may go.
    const { shop, sid, pid } = await world({ soon: true });
    const at = Date.now();
    const limit = await leaveStudio(shop, 2, at);
    const refused = await remove(pid);
    assert.equal(refused.status, 429, "two units cannot admit the removal's three fixed units");
    assert.equal(await allowanceUsedExact(shop, "studio", at), limit - 2, "the refused removal spends none of the two");
    assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 1, "the waitlist stays while the product stays");
  });
});

test("a removal refused before anything is held gives back the units it took beyond its own request (Claude 5's LOW on #4462)", async () => {
  await quiet(async () => {
    const { shop, sid, pid } = await world({ soon: true });
    // A pre-order that does not read counts as waiting: the removal is refused before anything is held or dropped.
    redis.run(["HSET", `nl:pre:${sid}:${pid}`, "someone", "not a pre-order"]);
    const at = Date.now();
    const before = await allowanceUsedExact(shop, "studio", at);
    assert.notEqual(before, null);
    const refused = await remove(pid);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(await allowanceUsedExact(shop, "studio", at), (before ?? 0) + 1, "only the request itself is counted, as for any refused write");
    assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 1, "the waitlist stays while the product stays");
  });
});

test("three studio requests left are enough for a whole removal: the product, its waitlist and its invitations' first page", async () => {
  await quiet(async () => {
    const { shop, sid, pid } = await world({ soon: true });
    const at = Date.now();
    const limit = await leaveStudio(shop, 3, at);
    const answer = await remove(pid);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 0, "the addresses are gone");
    assert.equal(await allowanceUsedExact(shop, "studio", at), limit, "exactly the three fixed units, taken once");
  });
});

test("a product off coming soon whose drop fails is still reached by an erasure, said pending, and finished when asked again", async () => {
  await quiet(async () => {
    const { sid, pid } = await world({ soon: false });
    const base: Pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands) => {
      if (commands.some((c) => c[0] === "DEL" && c[1] === `nl:wl:${sid}:${pid}`)) throw new Error("synthetic Redis failure");
      return base(commands);
    }) as Pipeline;
    let first: Awaited<ReturnType<typeof remove>>;
    try { first = await remove(pid); } finally { redis.pipeline = base; }
    assert.equal(first.body.ok, true, "the product itself is removed");
    assert.equal(first.body.cleanupPending, true, "a waitlist not confirmed gone is said, never a removal finished");
    const shop = (await storeForEmail(owner))!;
    assert.equal(shop.catalog.items.some((item) => item.id === pid), false);
    const erased = await erasePerson(shop, person, { kind: "person" });
    const kept = redis.run(["HGET", `nl:wl:${sid}:${pid}`, person]) !== null;
    assert.equal(erased.ok && kept, false, "an erasure never answers done while the person's place is kept");
    assert.equal(kept, false, "the erasure reaches the waitlist of the product still dropping");
    const again = await remove(pid);
    assert.equal(again.status, 200, "asking again finishes the drop");
    assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 0, "the addresses are gone");
    assert.equal(redis.run(["SISMEMBER", `nl:wl:${sid}:soon:dropping`, pid]), 0, "and the note that led to them, only then");
  });
});

test("an impossible reply never proves the waitlist gone, and the note that leads to it stays", async () => {
  const { sid, pid } = await world({ soon: false });
  const hold = named.holdWaitlistDrop as ((sid: string, pid: string) => Promise<void>) | undefined;
  assert.equal(typeof hold, "function", "lib/waitlist.ts has holdWaitlistDrop");
  await hold!(sid, pid);
  const base: Pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands) => {
    const replies = await base(commands);
    return commands.map((c, i) => (c[0] === "DEL" && c[1] === `nl:wl:${sid}:${pid}` ? 4 : replies[i]));
  }) as Pipeline;
  try {
    await assert.rejects(waitlist.dropWaitlist(sid, pid), UnknownReplyError);
  } finally { redis.pipeline = base; }
  assert.equal(redis.run(["SISMEMBER", `nl:wl:${sid}:soon:dropping`, pid]), 1, "still noted as dropping");
});

test("a join that passed its coming-soon check before the removal never writes its address after the drop", async () => {
  await quiet(async () => {
    const { shop, sid, pid, made } = await world({ soon: true });
    const joiner = "waitlist-pending-joiner@example.test";
    const base: Pipeline = redis.pipeline.bind(redis);
    let dropped = false;
    // The creator's removal lands between the join's coming-soon check and its write.
    const intercept = (async (commands) => {
      const writes = commands.some((c) => (c[0] === "HSET" && c[1] === `nl:wl:${sid}:${pid}`) || (c[0] === "EVAL" && c.includes(`nl:wl:${sid}:${pid}`) && String(c[1]).includes("SISMEMBER")));
      if (writes && !dropped) {
        dropped = true;
        redis.pipeline = base;
        try { await waitlist.dropWaitlist(sid, pid); } finally { redis.pipeline = intercept; }
      }
      return base(commands);
    }) as Pipeline;
    redis.pipeline = intercept;
    let result: string;
    try {
      result = await waitlist.joinWaitlist({ store: shop, product: made as unknown as Listing, email: joiner, consent: false, ip: "203.0.113.9", origin: "https://marktmorgen.com" });
    } finally { redis.pipeline = base; }
    assert.equal(dropped, true, "the removal ran between the check and the write");
    assert.equal(redis.run(["HGET", `nl:wl:${sid}:${pid}`, joiner]), null, `the address is not written after the drop (join answered ${result})`);
    assert.equal(result, "closed");
  });
});

test("a join asked again over its place never rewrites it after the removal's drop (the fenced swap, merge of main)", async () => {
  await quiet(async () => {
    const { shop, sid, pid, made } = await world({ soon: true });
    const joiner = "waitlist-pending-again@example.test";
    const join = () => waitlist.joinWaitlist({ store: shop, product: made as unknown as Listing, email: joiner, consent: false, ip: "203.0.113.10", origin: "https://marktmorgen.com" });
    // This world sends no email, so the join answers without "sent"; only its written place matters here.
    await join();
    const placed = redis.run(["HGET", `nl:wl:${sid}:${pid}`, joiner]);
    assert.equal(typeof placed, "string", "the first join writes its place");
    const base: Pipeline = redis.pipeline.bind(redis);
    let dropped = false;
    let swapCommand: (string | number)[] | null = null;
    // Asked again: the removal lands between the re-read of its place and the write over it.
    const intercept = (async (commands) => {
      const swap = commands.find((c) => c[0] === "EVAL" && c.includes(`nl:wl:${sid}:${pid}`) && c.includes(placed as string));
      if (swap && !dropped) {
        dropped = true;
        swapCommand = swap;
        redis.pipeline = base;
        try { await waitlist.dropWaitlist(sid, pid); } finally { redis.pipeline = intercept; }
      }
      return base(commands);
    }) as Pipeline;
    redis.pipeline = intercept;
    let result: string;
    try { result = await join(); } finally { redis.pipeline = base; }
    assert.equal(dropped, true, "the removal ran between the re-read and the write over the place");
    assert.ok(String(swapCommand?.[1]).includes("SISMEMBER"), "the write over the place checks coming soon in the same step");
    assert.equal(redis.run(["HGET", `nl:wl:${sid}:${pid}`, joiner]), null, `the place is not written back after the drop (join answered ${result})`);
    assert.equal(result, "closed");
  });
});

test("an erasure counts every waitlist mark it walks, and an oversized set is unknown", async () => {
  const { shop, sid } = await world({ soon: true });
  const stale = Array.from({ length: 30 }, (_, i) => `gone${String(i).padStart(4, "0")}`);
  redis.run(["SADD", `nl:wl:${sid}:soon`, ...stale]);
  const scope = await erasureScope(shop, person);
  assert.ok(scope);
  const size = (await erasureSize(scope)) as unknown as Record<string, number>;
  assert.equal(size.waitlists, 31, "every mark read is counted: the 30 stale ones and the product's own");
  assert.ok(Object.hasOwn(ERASE_PER, "waitlists"), "and priced per mark");
  const work = erasureWork(size);
  const without = erasureWork({ ...size, waitlists: 0 });
  assert.ok(work.commands - without.commands >= 30 * 2, "at least the HDEL and the launch list's walk of each removed one");
  const cap = named.MAX_WAITLIST_MARKS as number;
  assert.equal(typeof cap, "number", "the marks have a cap");
  redis.run(["SADD", `nl:wl:${sid}:soon`, ...Array.from({ length: cap }, (_, i) => `over${i}`)]);
  await assert.rejects(erasureScope(shop, person), UnknownReplyError, "an oversized set is unknown, never walked unpaid");
});

test("a SMEMBERS reply shorter or longer than the counts just read is unknown, never the complete list of waitlists", async () => {
  // Codex X4 on #4462 at d499d7a3dd: SCARD said a mark exists, so a list without it would let the erasure skip that waitlist.
  for (const [what, change] of [
    ["one member short", (list: string[]) => list.slice(1)],
    ["one member more", (list: string[]) => [...list, "extra0001"]],
  ] as [string, (list: string[]) => string[]][]) {
    const { shop } = await world({ soon: true });
    const base: Pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: Parameters<Pipeline>[0]) => {
      const replies = await base(commands);
      if (commands.length === 2 && commands.every((command) => command[0] === "SMEMBERS")) return [change(replies[0] as string[]), replies[1]];
      return replies;
    }) as Pipeline;
    try {
      await assert.rejects(erasureScope(shop, person), UnknownReplyError, `${what}: the reply does not match SCARD, so the list is unknown`);
    } finally {
      redis.pipeline = base;
    }
    assert.ok(await erasureScope(shop, person), `${what}: control, the same world with replies that read is walked`);
  }
});

test("the hold and the drop are paid before anything goes, and the drop gives back the waitlist's room", async () => {
  const units = named.WAITLIST_DROP_UNITS as number;
  const most = named.WAITLIST_DROP_COMMANDS as number;
  const bytes = named.WAITLIST_DROP_BYTES as number;
  assert.equal(typeof units, "number", "lib/waitlist.ts names WAITLIST_DROP_UNITS");
  assert.ok(most <= units * UNIT_COMMANDS && bytes <= units * UNIT_BYTES, "the units cover the commands and bytes counted");
  const { shop, sid, pid } = await world({ soon: true });
  const base: Pipeline = redis.pipeline.bind(redis);
  let sent = 0, moved = 0;
  redis.pipeline = (async (commands) => {
    sent += commands.length;
    moved += JSON.stringify(commands).length;
    const replies = await base(commands);
    moved += JSON.stringify(replies).length;
    return replies;
  }) as Pipeline;
  try {
    await (named.holdWaitlistDrop as (sid: string, pid: string) => Promise<void>)(sid, pid);
    await waitlist.dropWaitlist(sid, pid, shop);
  } finally { redis.pipeline = base; }
  assert.ok(sent <= most, `the hold and the drop sent ${sent} commands, counted ${most}`);
  assert.ok(moved <= bytes, `and moved ${moved} bytes, counted ${bytes}`);
  assert.equal(redis.run(["HGET", dataKey(shop)!, `wl:${pid}`]), null, "the waitlist's room is given back");
  assert.equal(redis.run(["SISMEMBER", `nl:wl:${sid}:soon:dropping`, pid]), 0);
});
