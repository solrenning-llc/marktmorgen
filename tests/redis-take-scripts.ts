/**
 * The scripts of lib/redis-take.ts (and lib/community.ts's CAS_MEMBER), run by the stand-in Redis the tests use
 * (tests/redis-stub.ts), each as the same plain commands in one step: read
 * and deleted, written or deleted only as read. Kept beside the stub rather
 * than in lib/redis-memory.ts, so the scripts' tests need nothing of it but
 * its plain commands.
 */
import type { MemoryRedis } from "@/lib/redis-memory";

type Command = (string | number)[];
type Script = (run: (command: Command) => unknown, keys: string[], argv: string[]) => unknown;

const SCRIPTS: Record<string, Script> = {
  // lib/product-about-live.ts ABOUT_WRITE_IF_STORE_LIVE: a store's product description written (or compared and written) only
  // while it is not erasing and its id key still holds its ref. {1} written, {0, length} changed, {-1} gone, moved or erasing.
  "about-write-live:v2": (run, [storeId, erasing, about], [field, compare, expected, text, ref]) => {
    if (run(["HGET", erasing, field]) !== null) return [-1];
    if (run(["GET", storeId]) !== ref) return [-1];
    if (compare === "1") {
      const now = run(["GET", about]);
      const held = typeof now === "string" ? now : "";
      if (held !== expected) return [0, Buffer.byteLength(held, "utf8")];
    }
    run(text === "" ? ["DEL", about] : ["SET", about, text]);
    return [1];
  },
  // lib/card-update.ts KEEP_CARD_OPEN_IF_LIVE: a setup page kept only while its store (id key, or record before ids) is live.
  "card-open-live:v1": (run, [storeId, erasing, open], [erasingField, session, seconds]) => {
    if (run(["EXISTS", storeId]) !== 1 || run(["HEXISTS", erasing, erasingField]) === 1) return "gone";
    run(["SET", open, session, "EX", seconds]);
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
  "hash-swap-if:v1": (run, [hash], [field, was, next]) => {
    if (run(["HGET", hash, field]) !== was) return 0;
    run(["HSET", hash, field, next]);
    return 1;
  },
  "hash-del-if:v1": (run, [hash], [field, was]) => (run(["HGET", hash, field]) !== was ? 0 : run(["HDEL", hash, field])),
  "sales-goal-live:v1": (run, [live, erasing, key], [field, value]) => {
    if (run(["EXISTS", live]) !== 1 || run(["HEXISTS", erasing, field]) === 1) return -1;
    if (value === "") return run(["DEL", key]);
    run(["SET", key, value]);
    return 1;
  },
  "store-forget-complete:v1": (run, [queue, month], [field, seconds]) => {
    if (run(["HDEL", queue, field]) !== 1) return [0, 0];
    const done = run(["HINCRBY", month, "done", 1]);
    run(["EXPIRE", month, seconds]);
    return [1, done];
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
  // lib/live-fence.ts STORE_LIVE_READ: SET_IF_STORE_LIVE's identity rule, read only; 1 live, 0 gone or erasing, -1 unreadable.
  "store-live-read:v1": (run, [live, erasing], [field, statsId, ref]) => {
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
    return 1;
  },
  "zset-take-count:v1": (run, [zset]) => {
    const n = Number(run(["ZCARD", zset])) || 0;
    run(["DEL", zset]);
    return n;
  },
  // lib/community.ts CAS_MEMBER: a member's record written only over what was read, the directory with it.
  "member-cas:v1": (run, [members, dir], [member, was, next, listed, at]) => {
    if (run(["HGET", members, member]) !== was) return 0;
    run(["HSET", members, member, next]);
    run(listed === "1" ? ["ZADD", dir, at, member] : ["ZREM", dir, member]);
    return 1;
  },
  "recovery-report-live:v1": (run, [storeId, erasing, report], [field, value, seconds]) => {
    if (Number(run(["EXISTS", storeId])) !== 1 || run(["HGET", erasing, field]) !== null) return 0;
    run(["SET", report, value, "EX", seconds]);
    return 1;
  },
  "set-and-values-take:v1": (run, [set, ...plain]) => {
    const members = Number(run(["SCARD", set])) > 0 ? (run(["SMEMBERS", set]) as string[]) : [];
    const values = plain.map((k) => run(["GET", k]) ?? null);
    const gone = (members.length ? 1 : 0) + values.filter((v) => v !== null).length;
    run(["DEL", set, ...plain]);
    return [members, values, gone];
  },
  "recent-feed-live:v2": (run, [live, erasing, feed], [field, json, seconds, ref]) => {
    if (run(["GET", live]) !== ref || Number(run(["HEXISTS", erasing, field])) === 1) return "gone";
    run(["SET", feed, json, "EX", seconds]);
    return 1;
  },
  // lib/recent-sales.ts KEEP_SALE_IF_LIVE: a purchase written down (and the feed dropped) only while the store is live.
  "recent-sale-live:v2": (run, [live, erasing, list, feed], [field, json, last, seconds, ref]) => {
    if (run(["GET", live]) !== ref || Number(run(["HEXISTS", erasing, field])) === 1) return "gone";
    run(["LPUSH", list, json]);
    run(["LTRIM", list, 0, last]);
    run(["EXPIRE", list, seconds]);
    run(["DEL", feed]);
    return 1;
  },
};

/** The names of the scripts above, for tests/redis-memory-take-scripts.test.ts. */
export const TAKE_SCRIPT_NAMES: readonly string[] = Object.keys(SCRIPTS);

/** Makes `store` run the named scripts above, and everything else as before. */
export function withTakeScripts(store: MemoryRedis): MemoryRedis {
  const base = store.run.bind(store);
  store.run = (command: Command): unknown => {
    if (command[0] === "EVAL") {
      const name = /^-- marktmorgen:([a-z-]+:v\d+)\n/.exec(String(command[1]))?.[1];
      const script = name ? SCRIPTS[name] : undefined;
      if (script) {
        const count = Number(command[2]);
        const rest = command.slice(3).map(String);
        return script(base, rest.slice(0, count), rest.slice(count));
      }
    }
    return base(command);
  };
  return store;
}
