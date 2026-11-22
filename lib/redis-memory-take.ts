/**
 * A mirror, for lib/redis-memory.ts, of the scripts the tests' stand-in Redis runs (tests/redis-take-scripts.ts): the
 * scripts of lib/redis-take.ts and their kin (lib/card-update.ts, lib/sales-goal.ts, lib/live-fence.ts,
 * lib/store-live-cache.ts, lib/community.ts's CAS_MEMBER, lib/payment-recovery-report.ts, lib/recent-sales.ts), each
 * as the same plain commands in one step. Before 22/11/2026 they lived only in the stand-in, so `next dev`, the demo
 * store and the Mobile render job, which use MemoryRedis with no test stub, refused them (#4969). Keyed by the name on
 * the script's first line (`-- marktmorgen:<name>`), in alphabetical order (AGENTS.md AC (q)).
 * tests/redis-memory-take-scripts.test.ts runs every script of the stand-in here too and fails when one is missing or
 * answers differently, so a script added to the stand-in is added here in the same PR.
 */
type Command = (string | number)[];
export type TakeScript = (run: (command: Command) => unknown, keys: string[], argv: string[]) => unknown;

export const TAKE_SCRIPTS: Readonly<Record<string, TakeScript>> = {
  // lib/card-update.ts KEEP_CARD_OPEN_IF_LIVE: a setup page kept only while its store (id key, or record before ids) is live.
  "card-open-live:v1": (run, [storeId, erasing, open], [erasingField, session, seconds]) => {
    if (run(["EXISTS", storeId]) !== 1 || run(["HEXISTS", erasing, erasingField]) === 1) return "gone";
    run(["SET", open, session, "EX", seconds]);
    return 1;
  },
  "hash-del-if:v1": (run, [hash], [field, was]) => (run(["HGET", hash, field]) !== was ? 0 : run(["HDEL", hash, field])),
  "hash-swap-if:v1": (run, [hash], [field, was, next]) => {
    if (run(["HGET", hash, field]) !== was) return 0;
    run(["HSET", hash, field, next]);
    return 1;
  },
  "hash-take-all:v1": (run, [hash]) => {
    const held = run(["HGETALL", hash]) as string[];
    // Deleted either way: reading a missing hash in the stand-in leaves an empty one behind, which Redis never has.
    run(["DEL", hash]);
    return held;
  },
  "hash-take-field:v1": (run, [hash], [field]) => {
    const value = run(["HGET", hash, field]);
    if (typeof value === "string") run(["HDEL", hash, field]);
    return value ?? null;
  },
  // lib/community.ts CAS_MEMBER: a member's record written only over what was read, the directory with it.
  "member-cas:v1": (run, [members, dir], [member, was, next, listed, at]) => {
    if (run(["HGET", members, member]) !== was) return 0;
    run(["HSET", members, member, next]);
    run(listed === "1" ? ["ZADD", dir, at, member] : ["ZREM", dir, member]);
    return 1;
  },
  "recent-feed-live:v2": (run, [live, erasing, feed], [field, json, seconds, ref]) => {
    if (run(["GET", live]) !== ref || Number(run(["HEXISTS", erasing, field])) === 1) return "gone";
    run(["SET", feed, json, "EX", seconds]);
    return 1;
  },
  // lib/recent-sales.ts KEEP_SALE_IF_LIVE: a purchase written down only while the store's id key holds its ref and its
  // erasure has not begun; "gone", nothing written (#4965).
  "recent-sale-live:v2": (run, [live, erasing, list, feed], [field, json, last, seconds, ref]) => {
    if (run(["GET", live]) !== ref || Number(run(["HEXISTS", erasing, field])) === 1) return "gone";
    run(["LPUSH", list, json]);
    run(["LTRIM", list, 0, last]);
    run(["EXPIRE", list, seconds]);
    run(["DEL", feed]);
    return 1;
  },
  "recovery-report-live:v1": (run, [storeId, erasing, report], [field, value, seconds]) => {
    if (Number(run(["EXISTS", storeId])) !== 1 || run(["HGET", erasing, field]) !== null) return 0;
    run(["SET", report, value, "EX", seconds]);
    return 1;
  },
  "sales-goal-live:v1": (run, [live, erasing, key], [field, value]) => {
    if (run(["EXISTS", live]) !== 1 || run(["HEXISTS", erasing, field]) === 1) return -1;
    if (value === "") return run(["DEL", key]);
    run(["SET", key, value]);
    return 1;
  },
  "set-and-values-take:v1": (run, [set, ...plain]) => {
    const members = Number(run(["SCARD", set])) > 0 ? (run(["SMEMBERS", set]) as string[]) : [];
    const values = plain.map((k) => run(["GET", k]) ?? null);
    const gone = (members.length ? 1 : 0) + values.filter((v) => v !== null).length;
    run(["DEL", set, ...plain]);
    return [members, values, gone];
  },
  "set-take-count:v1": (run, [set]) => {
    const n = Number(run(["SCARD", set])) || 0;
    run(["DEL", set]);
    return n;
  },
  // lib/live-fence.ts SET_IF_STORE_LIVE: a store's cache written only while it is not erasing and its key is still
  // its own: the id key holds this store's ref, or (from before ids) the owner's record carries its statsId.
  "store-cache-live:v3": (run, [live, erasing, key], [field, value, seconds, statsId, ref]) => {
    if (run(["HGET", erasing, field]) !== null) return 0;
    if (statsId === "") {
      if (run(["GET", live]) !== ref) return 0;
    } else {
      const raw = run(["GET", live]);
      if (raw === null) return 0;
      let record: unknown;
      try {
        record = JSON.parse(String(raw));
      } catch {
        return -1;
      }
      if (!record || typeof record !== "object") return -1;
      if ((record as { statsId?: unknown }).statsId !== statsId) return 0;
    }
    run(["SET", key, value, "EX", seconds]);
    return 1;
  },
  // lib/store-live-cache.ts CLAIM_IF_STORE_LIVE: a mark taken once (SET NX) only while the store is its own and not
  // erasing, by the same identity rule; -1 gone or erasing, -2 an owner's record that does not parse, 1 ours, 0 taken.
  "store-claim-live:v1": (run, [live, erasing, key], [field, value, seconds, statsId, ref]) => {
    if (run(["HGET", erasing, field]) !== null) return -1;
    if (statsId === "") {
      if (run(["GET", live]) !== ref) return -1;
    } else {
      const raw = run(["GET", live]);
      if (raw === null) return -1;
      let record: unknown;
      try {
        record = JSON.parse(String(raw));
      } catch {
        return -2;
      }
      if (!record || typeof record !== "object") return -2;
      if ((record as { statsId?: unknown }).statsId !== statsId) return -1;
    }
    return run(["SET", key, value, "NX", "EX", seconds]) === "OK" ? 1 : 0;
  },
  // lib/live-fence.ts COUNT_IF_STORE_LIVE: a count of the month added to (INCRBY argv[2], EXPIRE argv[3]) only while the
  // store is its own and not erasing, by the same identity rule; the count after it (10th audit on #5092, LEVE 5).
  "store-count-live:v1": (run, keys, [field, n, seconds, statsId, ref]) => {
    const [live, erasing, count] = keys;
    if (run(["HGET", erasing, field]) !== null) return 0;
    if (statsId === "") {
      if (run(["GET", live]) !== ref) return 0;
    } else {
      const raw = run(["GET", live]);
      if (raw === null) return 0;
      let record: unknown;
      try {
        record = JSON.parse(String(raw));
      } catch {
        return -1;
      }
      if (!record || typeof record !== "object") return -1;
      if ((record as { statsId?: unknown }).statsId !== statsId) return 0;
    }
    const after = run(["INCRBY", count, Number(n)]);
    run(["EXPIRE", count, seconds]);
    return Number(after);
  },
  // lib/live-fence.ts WRITE_IF_STORE_LIVE: several writes made together only while the store is its own and not
  // erasing, by the same identity rule; argv[4] lists them as JSON, {"k": n} standing for KEYS[n] (Codex L-20261120-0838).
  "store-write-live:v1": (run, keys, [field, statsId, ref, commands]) => {
    const [live, erasing] = keys;
    if (run(["HGET", erasing, field]) !== null) return 0;
    if (statsId === "") {
      if (run(["GET", live]) !== ref) return 0;
    } else {
      const raw = run(["GET", live]);
      if (raw === null) return 0;
      let record: unknown;
      try {
        record = JSON.parse(String(raw));
      } catch {
        return -1;
      }
      if (!record || typeof record !== "object") return -1;
      if ((record as { statsId?: unknown }).statsId !== statsId) return 0;
    }
    for (const command of JSON.parse(String(commands)) as (string | number | { k: number })[][]) {
      run(command.map((part) => (typeof part === "object" && part !== null ? keys[part.k - 1] : part)));
    }
    return 1;
  },
  "zset-take-count:v1": (run, [zset]) => {
    const n = Number(run(["ZCARD", zset])) || 0;
    run(["DEL", zset]);
    return n;
  },
};
