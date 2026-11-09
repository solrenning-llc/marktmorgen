import { createHash } from "node:crypto";
import { PATH_BOARD_ROOM_BYTES, readPathBoard, pathBoardMember } from "@/lib/path-board-rules";
/**
 * A Redis that lives in memory, for testing the parts of this codebase whose
 * behaviour only shows up across several commands.
 *
 * Pure functions can be checked by calling them. What cannot be checked that
 * way is a flow: a first message becoming a request, the request being
 * accepted, a decline taking the messages with it and shutting the sender out.
 * Those live in the order of the writes, not in any one function, and the only
 * honest way to check them without two people and two inboxes is to run them
 * against something that behaves like the store they were written for.
 *
 * It implements only the commands this codebase actually uses, and it answers
 * in the shapes Upstash's REST API answers in — a flat array for ZREVRANGE
 * WITHSCORES, null for a missing ZSCORE, the integer 1 or 0 for SISMEMBER.
 * Anything not implemented throws by name rather than quietly returning null,
 * so a test can never pass because a command silently did nothing.
 *
 * This is not a Redis. It is a test double, kept beside the code it doubles so
 * that a command added to one is noticed as missing in the other.
 */

type Entry = string | string[] | Map<string, string> | Set<string> | { score: number; member: string }[];

export class MemoryRedis {
  private data = new Map<string, Entry>();
  /** When a key stops existing, in ms since the epoch. */
  private until = new Map<string, number>();
  /**
   * The clock, so a test can move time rather than wait for it. A cooldown
   * measured in minutes is not a thing to sit through.
   */
  now = () => Date.now();

  /** Moves the clock forward, for a test that has to outlast an expiry. */
  advance(ms: number): void {
    const to = this.now() + ms;
    this.now = () => to;
  }

  /** Everything, thrown away. */
  clear(): void {
    this.data.clear();
    this.until.clear();
    this.now = () => Date.now();
  }

  /** Drops a key whose time is up, before anything reads it. */
  private live(key: string): void {
    const ends = this.until.get(key);
    if (ends !== undefined && this.now() >= ends) {
      this.data.delete(key);
      this.until.delete(key);
    }
  }

  /** For a test to look at what a flow left behind. */
  keys(): string[] {
    return [...this.data.keys()].sort();
  }

  private list(key: string): string[] {
    const held = this.data.get(key);
    if (Array.isArray(held) && (held.length === 0 || typeof held[0] === "string")) return held as string[];
    const made: string[] = [];
    this.data.set(key, made);
    return made;
  }

  private hash(key: string): Map<string, string> {
    const held = this.data.get(key);
    if (held instanceof Map) return held;
    const made = new Map<string, string>();
    this.data.set(key, made);
    return made;
  }

  private set(key: string): Set<string> {
    const held = this.data.get(key);
    if (held instanceof Set) return held;
    const made = new Set<string>();
    this.data.set(key, made);
    return made;
  }

  private zset(key: string): { score: number; member: string }[] {
    const held = this.data.get(key);
    if (Array.isArray(held) && (held.length === 0 || typeof held[0] === "object")) {
      return held as { score: number; member: string }[];
    }
    const made: { score: number; member: string }[] = [];
    this.data.set(key, made);
    return made;
  }

  /** Runs one command, the way redisPipeline runs each of its own. */
  run(command: (string | number)[]): unknown {
    const [rawName, ...rest] = command;
    const name = String(rawName).toUpperCase();
    const key = String(rest[0] ?? "");
    const args = rest.slice(1).map(String);
    // Redis checks command arity before looking up or changing any key.
    const minimum = name === "HSET" || name === "ZADD" ? 4
      : name === "DEL" || name === "MGET" ? 2
      : ["HDEL", "SADD", "SREM", "ZREM", "LPUSH", "RPUSH", "HMGET"].includes(name) ? 3 : 0;
    if (command.length < minimum || (name === "HSET" && command.length % 2 !== 0)) {
      throw new Error(`ERR wrong number of arguments for '${name.toLowerCase()}' command`);
    }
    if (name === "ZADD") {
      let firstPair = 0;
      while (["NX", "XX", "GT", "LT", "CH", "INCR"].includes(args[firstPair]?.toUpperCase())) firstPair += 1;
      if ((args.length - firstPair) === 0 || (args.length - firstPair) % 2 !== 0) throw new Error("ERR syntax error");
    }
    this.live(key);

    switch (name) {
      case "GETRANGE": {
        if (args.length !== 2 || !args.every(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error("invalid GETRANGE range");
        const held = this.data.get(key);
        if (held === undefined) return "";
        if (typeof held !== "string") throw new Error("WRONGTYPE");
        const bytes = new TextEncoder().encode(held);
        const edge = (raw: string) => Number(raw) < 0 ? bytes.length + Number(raw) : Number(raw);
        const from = Math.max(0, edge(args[0])), to = Math.min(bytes.length - 1, edge(args[1]));
        return to < from ? "" : new TextDecoder().decode(bytes.slice(from, to + 1));
      }
      case "EVAL": {
        // lib/form-store.ts FIND_FORM_RESPONSE: the first kept response written with this id, as its text, or nil.
        if (key.startsWith("-- marktmorgen:form-find:v1\n") && args[0] === "1" && args.length === 4) {
          const [, listKey, id, kept] = args;
          this.live(listKey);
          if (!this.data.has(listKey)) return null;
          for (const raw of this.list(listKey).slice(0, Number(kept))) {
            if (!raw.includes(`"id":"${id}"`)) continue;
            try {
              const value = JSON.parse(raw) as unknown;
              if (!value || typeof value !== "object" || Array.isArray(value) || (value as { id?: unknown }).id === id) return raw;
            } catch {
              return raw;
            }
          }
          return null;
        }
        // lib/community.ts GIVE_BACK_HANDLE: a handle deleted only while it points at the member and their record does not carry it.
        if (key.startsWith("-- marktmorgen:community-handle-give-back:v1\n") && args[0] === "2" && args.length === 5) {
          const [, members, handles, handle, who] = args;
          if (this.run(["HGET", handles, handle]) !== who) return 0;
          const raw = this.run(["HGET", members, who]);
          if (typeof raw === "string") {
            let record: unknown;
            try {
              record = JSON.parse(raw);
            } catch {
              return -1;
            }
            if (!record || typeof record !== "object") return -1;
            if ((record as { h?: unknown }).h === handle) return 0;
          }
          return this.run(["HDEL", handles, handle]);
        }
        // lib/group-buy.ts PLACE_RELEASE: a place's opening hold deleted only while its token is still the open's own.
        if (key.startsWith("-- marktmorgen:group-place-release:v1\n") && args[0] === "1" && args.length === 3) {
          const [, hold, token] = args;
          return this.run(["GET", hold]) === token ? this.run(["DEL", hold]) : 0;
        }
        // lib/group-buy.ts PLACE_DONE: a place marked done once, and said so only to the open that did it.
        if (key.startsWith("-- marktmorgen:group-place-done:v1\n") && args[0] === "1" && args.length === 4) {
          const [, members, field, json] = args;
          const now = this.run(["HGET", members, field]);
          if (now === null || now === undefined) {
            this.run(["HSET", members, field, json]);
            return 2;
          }
          let mark: unknown;
          try {
            mark = JSON.parse(String(now));
          } catch {
            return -1;
          }
          if (!mark || typeof mark !== "object") return -1;
          if ((mark as { d?: unknown }).d === 1) return 0;
          this.run(["HSET", members, field, json]);
          return 1;
        }
        // lib/agent-book.ts AGENT_BOOK_WRITE: the agent book written only while the writer still holds the store's lock.
        if (key.startsWith("-- marktmorgen:agent-book-write:v1\n") && args[0] === "2" && args.length === 5) {
          const [, lock, book, token, json] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(["SET", book, json]);
          return 1;
        }
        // lib/contacts.ts CAS_HSET: each contact set only while it still holds what was read (its SHA-1, "" for none), in one step.
        if (key.startsWith("-- marktmorgen:contact-cas-hset:v1\n") && args[0] === "1" && args.length >= 5 && (args.length - 2) % 3 === 0) {
          const target = args[1];
          const out: number[] = [];
          for (let i = 2; i < args.length; i += 3) {
            const current = this.run(["HGET", target, args[i]]);
            const seen = typeof current === "string" ? createHash("sha1").update(current).digest("hex") : "";
            if (seen === args[i + 1]) this.run(["HSET", target, args[i], args[i + 2]]);
            out.push(seen === args[i + 1] ? 1 : 0);
          }
          return out;
        }
        // lib/assignment.ts HAND_IN_WRITE_IF: a student's work written only over the one it was read as.
        if (key.startsWith("-- marktmorgen:hand-in-write-if:v1\n") && args[0] === "4" && args.length === 12) {
          const [, sub, files, waiting, all, expected, json, path, bytes, review, at, member] = args;
          const now = this.run(["GET", sub]);
          if ((typeof now === "string" ? now : "") !== expected) return 0;
          this.run(["SET", sub, json]);
          if (path !== "") this.run(["HSET", files, path, bytes]);
          this.run(review === "1" ? ["ZADD", waiting, at, member] : ["ZREM", waiting, member]);
          this.run(["ZADD", all, at, member]);
          return 1;
        }
        // lib/product-about.ts WRITE_ABOUT_IF: the description written only over the one it was read as.
        if (key.startsWith("-- marktmorgen:about-write-if:v1\n") && args[0] === "1" && args.length === 4) {
          const [, about, expected, text] = args;
          const now = this.run(["GET", about]);
          const held = typeof now === "string" ? now : "";
          if (held !== expected) return [0, Buffer.byteLength(held, "utf8")];
          this.run(text === "" ? ["DEL", about] : ["SET", about, text]);
          return [1];
        }
        // lib/paypal-sales.ts PAYPAL_REVOKE: a refunded payment's purchase taken back only while nothing else stands for it.
        if (key.startsWith("-- marktmorgen:paypal-revoke:v1\n") && args[0] === "2" && args.length >= 5) {
          const [, imported, own, field, job, ...known] = args;
          const members = this.run(["SMEMBERS", own]);
          if ((Array.isArray(members) ? members : []).some((member) => !known.includes(String(member)))) return 0;
          const raw = this.run(["HGET", imported, field]);
          if (raw === null || raw === undefined) return 2;
          let record: unknown;
          try {
            record = JSON.parse(String(raw));
          } catch {
            return 0;
          }
          if (!record || typeof record !== "object" || (record as { job?: unknown }).job !== job) return 0;
          this.run(["HDEL", imported, field]);
          return 1;
        }
        // lib/assistant-memory-store.ts MEMORY_WRITE: the notes written or deleted only while the change's lock is its own.
        if (key.startsWith("-- marktmorgen:amem-write:v1\n") && args[0] === "2" && args.length === 5) {
          const [, lock, notes, token, json] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(json === "" ? ["DEL", notes] : ["SET", notes, json]);
          return 1;
        }
        // lib/assistant-memory-store.ts MEMORY_FORGET: the lock made the forgetting's own and the notes deleted in one step.
        if (key.startsWith("-- marktmorgen:amem-forget:v3\n") && args[0] === "2" && args.length === 5) {
          this.run(["SET", args[1], args[3], "EX", args[4]]);
          const length = this.run(["STRLEN", args[2]]);
          return [this.run(["DEL", args[2]]), length];
        }
        // DR1: one provider receipt and its campaign counter, atomically.
        if (key.startsWith("-- marktmorgen:mail-report:v1\n") && args[0] === "1" && args.length === 7) {
          const [, daily, receipt, aggregate, count, expiry, limit] = args;
          const type = this.run(["TYPE", daily]);
          if (type !== "none" && type !== "hash") return -1;
          const old = this.run(["HGET", daily, receipt]);
          const total = this.run(["HGET", daily, aggregate]);
          if (total !== null && (!/^(0|[1-9][0-9]*)$/.test(String(total)) || Number(total) > 1_000_000_000)) return -1;
          if (old !== null) return old === count && total !== null && Number(total) >= Number(count) ? 2 : -1;
          if (Number(this.run(["HLEN", daily])) + (total === null ? 2 : 1) > Number(limit)) return -1;
          this.run(["HSET", daily, receipt, count]);
          this.run(["HINCRBY", daily, aggregate, count]);
          this.run(["EXPIREAT", daily, expiry]);
          return 1;
        }
        // CX-67: existing exposure reservation used by held-store company work.
        if (key.includes("local receiptField='case:'..ARGV[3]..':'..ARGV[4]") && args[0] === "1" && args.length === 9) {
          const [, ledger, review, binding, scope, id, rawCharge, rawLimit, rawFunded] = args;
          const amount = (raw: unknown): number | null => typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= 1e12 ? Number(raw) : null;
          if (this.run(["TYPE", ledger]) !== "hash" || this.run(["TTL", ledger]) !== -1) return 0;
          if (this.run(["HGET", ledger, "review"]) !== review || this.run(["HGET", ledger, "policy"]) !== binding) return 0;
          const reserved = amount(this.run(["HGET", ledger, "reserved"]));
          const charge = amount(rawCharge), limit = amount(rawLimit), funded = amount(rawFunded);
          const slots = amount(this.run(["HGET", ledger, "slots:" + scope]));
          const field = "case:" + scope + ":" + id, raw = this.run(["HGET", ledger, field]);
          if (reserved === null || charge === null || limit === null || funded === null || funded <= 0 || slots === null || slots > funded || reserved > limit) return 0;
          if (raw !== null) return amount(raw) === charge && reserved >= charge && slots < funded ? 1 : 0;
          if (slots <= 0 || charge > limit - reserved) return 0;
          this.run(["HINCRBY", ledger, "slots:" + scope, -1]);
          this.run(["HSET", ledger, field, rawCharge]);
          this.run(["HINCRBY", ledger, "reserved", rawCharge]); return 1;
        }
        // CX-67: atomic held membership and aggregate observations.
        // lib/webhooks.ts READ_DELIVERIES: each delivery read only while it is no larger than its bound, {0} at the first larger one.
        if (key.startsWith("-- marktmorgen:webhook-deliveries-read:v1\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count);
          const bounds = args.slice(1 + count);
          const out: (string | null)[] = [];
          for (let i = 0; i < keys.length; i += 1) {
            const n = Number(this.run(["STRLEN", keys[i]]) ?? 0);
            if (n > Number(bounds[i])) return [0];
            const value = n > 0 ? this.run(["GET", keys[i]]) : null;
            out.push(typeof value === "string" ? value : null);
          }
          return [1, out];
        }
        if (key.startsWith("-- marktmorgen:held-state:v1\n") && args[0] === "2" && args.length === 6) {
          const [, index, month, held, ref, due] = args;
          if (Array.isArray(this.data.get(index)) && (this.data.get(index) as unknown[]).length === 0) this.data.delete(index);
          if (!["none", "zset"].includes(this.run(["TYPE", index]) as string) || !["none", "hash"].includes(this.run(["TYPE", month]) as string)) return -1;
          if (held === "1") this.run(["ZADD", index, due, ref]); else this.run(["ZREM", index, ref]);
          this.run(["HDEL", month, "complete"]); return 1;
        }
        if (key.startsWith("-- marktmorgen:held-month:v1\n") && args[0] === "2" && args.length === 6) {
          const [, index, month, day, complete, seconds] = args;
          if (Array.isArray(this.data.get(index)) && (this.data.get(index) as unknown[]).length === 0) this.data.delete(index);
          if (!["none", "zset"].includes(this.run(["TYPE", index]) as string) || !["none", "hash"].includes(this.run(["TYPE", month]) as string)) return -1;
          const raw = this.run(["HGET", month, "peak"]);
          if (raw !== null && !/^(0|[1-9][0-9]*)$/.test(String(raw))) return -1;
          const peak = Number(raw ?? 0);
          if (!Number.isSafeInteger(peak)) return -1;
          const count = this.run(["ZCARD", index]) as number;
          this.run(["HSET", month, "count", count, "peak", Math.max(count, peak), "day", day, "complete", complete]);
          this.run(["EXPIRE", month, seconds]); return 1;
        }
        // CX-67: one funded held-store reconfirmation per UTC day, site ceiling.
        if (key.startsWith("-- marktmorgen:held-recheck:v1\n") && args[0] === "1" && args.length === 5) {
          const [, ledger, ref, rawLimit, seconds] = args;
          const type = this.run(["TYPE", ledger]);
          if (type !== "none" && type !== "hash") return -1;
          const raw = this.run(["HGET", ledger, "count"]);
          if (type === "hash" && raw === null || raw !== null && !/^(0|[1-9][0-9]*)$/.test(String(raw))) return -1;
          const count = raw === null ? 0 : Number(raw), limit = Number(rawLimit);
          if (!Number.isSafeInteger(count) || count < 0 || count > limit) return -1;
          const seen = this.run(["HGET", ledger, ref]);
          if (seen !== null) return seen === "1" ? 0 : -1;
          if (count >= limit) return 0;
          this.run(["HINCRBY", ledger, "count", 1]);
          this.run(["HSET", ledger, ref, "1"]);
          this.run(["EXPIRE", ledger, seconds]); return 1;
        }

        // lib/redis-lock.ts releaseLock and holdLock: the lock deleted, or made to last, only while it holds the token.
        if (key.startsWith("-- marktmorgen:release:v1\n") && args[0] === "1" && args.length === 3) {
          const [, lock, token] = args;
          return this.run(["GET", lock]) === token ? this.run(["DEL", lock]) : 0;
        }
        if (key.startsWith("-- marktmorgen:extend:v1\n") && args[0] === "1" && args.length === 4) {
          const [, lock, token, seconds] = args;
          return this.run(["GET", lock]) === token ? this.run(["EXPIRE", lock, seconds]) : 0;
        }
        // lib/calls.ts: a call lock's value swapped (take-over, renewal), and a hold written, only while the lock holds the value given.
        if (key.startsWith("-- marktmorgen:call-lock-swap:v1\n") && args[0] === "1" && args.length === 5) {
          const [, lock, from, to, seconds] = args;
          if (this.run(["GET", lock]) !== from) return 0;
          this.run(["SET", lock, to, "EX", seconds]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:call-hold-if-locked:v1\n") && args[0] === "2" && args.length === 6) {
          const [, lock, diary, token, field, value] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(["HSET", diary, field, value]);
          return 1;
        }
        // The fenced writes of lib/redis-lock.ts that never fall back: modeled step for step.
        if (key.startsWith("-- marktmorgen:fenced-set:v1\n") && args[0] === "2" && args.length === 5) {
          const [, lock, target, token, value] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(["SET", target, value]);
          return 1;
        }
        // An agreement's record, written with its expiry only while the agreement's lock is the writer's (lib/agreement-store.ts, AGREEMENT_SAVE).
        if (key.startsWith("-- marktmorgen:agreement-save:v1\n") && args[0] === "2" && args.length === 6) {
          const [, lock, target, token, value, seconds] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(["SET", target, value, "EX", seconds]);
          return 1;
        }
        // The customer voice's summary, written only while its reading's lock is its own (lib/customer-voice.ts, VOICE_KEEP).
        if (key.startsWith("-- marktmorgen:voice-keep:v1\n") && args[0] === "2" && args.length === 6) {
          const [, lock, target, token, value, seconds] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          this.run(["SET", target, value, "EX", seconds]);
          this.run(["DEL", lock]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:fenced-set-new:v1\n") && args[0] === "2" && args.length === 5) {
          const [, lock, target, token, value] = args;
          if (this.run(["GET", lock]) !== token || Number(this.run(["EXISTS", target])) !== 0) return 0;
          this.run(["SET", target, value]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:fenced-del:v1\n") && Number(args[0]) >= 2 && args.length === Number(args[0]) + 2) {
          const count = Number(args[0]);
          const lock = args[1];
          const targets = args.slice(2, count + 1);
          if (this.run(["GET", lock]) !== args[count + 1]) return 0;
          for (const target of targets) this.run(["DEL", target]);
          return 1;
        }
        // lib/payment-request-store.ts SAVE: a request's record written only while its write lock is the writer's,
        // "new" only when absent, "edit" only over the record still there, with its open entry and reminder in step.
        if (key.startsWith("-- marktmorgen:payreq-save:v1\n") && args[0] === "4" && args.length === 13) {
          const [, lock, target, open, due, token, mode, value, seconds, id, openScore, member, dueScore] = args;
          if (this.run(["GET", lock]) !== token) return 0;
          const there = Number(this.run(["EXISTS", target]));
          if ((mode === "new" && there !== 0) || (mode !== "new" && there !== 1)) return 2;
          this.run(["SET", target, value, "EX", seconds]);
          if (mode === "edit") {
            this.run(openScore === "" ? ["ZREM", open, id] : ["ZADD", open, openScore, id]);
            this.run(dueScore === "" ? ["ZREM", due, member] : ["ZADD", due, dueScore, member]);
          }
          return 1;
        }
        if (key.startsWith("-- marktmorgen:pause-due-observation:v1\n") && args[0] === "1" && args.length === 3) {
          const [,target,deadline]=args;
          if(!/^(0|[1-9][0-9]*)$/.test(deadline)||Number(deadline)>1_000_000_000_000)return [-1];
          this.live(target);
          const value=this.data.get(target);
          if(value===undefined)return [];
          if(!Array.isArray(value))return [-1];
          const refs=this.run(["ZRANGEBYSCORE",target,"-inf",deadline,"LIMIT",0,200]) as string[];
          return refs.some(ref=>ref.length===0||new TextEncoder().encode(ref).length>1280)?[-1]:refs;
        }
        if (key.startsWith("-- marktmorgen:pause-observation:v1\n") && args[0] === "1" && args.length === 2) {
          const target = args[1];
          this.live(target);
          const current = this.data.get(target);
          if (current === undefined) return [0];
          if (typeof current !== "string") return [-1];
          const bytes = new TextEncoder().encode(current);
          const bounded = bytes.slice(0, 4097);
          if (bounded.length === 0 || bounded.length > 4096) return [-1];
          return [1, new TextDecoder().decode(bounded)];
        }
        if (key.startsWith("-- marktmorgen:pause-worker-notice:v1\n") && args[0] === "2" && args.length === 7) {
          const [, target, due, ref, expected, next, rawNow] = args;
          const now = Number(rawNow);
          if (target === due || !Number.isSafeInteger(now) || now <= 0) return 0;
          this.live(target); this.live(due);
          const current = this.data.get(target), index = this.data.get(due);
          if (current !== undefined && typeof current !== "string") throw new Error("WRONGTYPE");
          if (current !== expected) return 0;
          let p: Record<string, unknown>, q: Record<string, unknown>;
          try { p = JSON.parse(current as string); q = JSON.parse(next); } catch { return 0; }
          const fields = ["subscription", "customer", "paymentMethod", "tier", "from", "until", "told"];
          if (!p || !q || typeof p !== "object" || typeof q !== "object" ||
              Object.keys(p).some(k => !fields.includes(k)) || Object.keys(q).length !== 7 ||
              Object.keys(q).some(k => !fields.includes(k)) || (p.told !== undefined && p.told !== 0) ||
              q.told !== now || typeof p.until !== "number" || p.until <= now ||
              fields.some(k => k !== "told" && p[k] !== q[k])) return 0;
          if (index !== undefined && (!Array.isArray(index) || (index.length > 0 && typeof index[0] !== "object"))) throw new Error("WRONGTYPE");
          if (this.run(["ZSCORE", due, ref]) !== String(p.until)) return 0;
          // Match SET KEEPTTL: no expiry extension or removal.
          this.data.set(target, next);
          return 1;
        }

        if (key.startsWith("-- marktmorgen:pause-worker-forget:v1\n") && args[0] === "2" && args.length === 6) {
          const [, target, due, ref, mode, expected] = args;
          if (target === due) return 0;
          this.live(target); this.live(due);
          const current = this.data.get(target), index = this.data.get(due);
          if (current !== undefined && typeof current !== "string") throw new Error("WRONGTYPE");
          const removeDue = () => {
            if (index !== undefined && (!Array.isArray(index) || (index.length > 0 && typeof index[0] !== "object"))) throw new Error("WRONGTYPE");
            this.run(["ZREM", due, ref]);
          };
          if (mode === "missing") {
            if (current !== undefined) return 0;
            removeDue(); return 1;
          }
          if (mode !== "known" || current !== expected || typeof current !== "string" ||
              current.length === 0 || new TextEncoder().encode(current).length > 4096) return 0;
          let p: { funding?: unknown; until?: unknown };
          try { p = JSON.parse(current as string); } catch { return 0; }
          if (!p || typeof p !== "object" || Object.hasOwn(p, "funding") || typeof p.until !== "number") return 0;
          if (index !== undefined && (!Array.isArray(index) || (index.length > 0 && typeof index[0] !== "object"))) throw new Error("WRONGTYPE");
          if (this.run(["ZSCORE", due, ref]) !== String(p.until)) return 0;
          this.run(["DEL", target]); removeDue(); return 1;
        }

        // lib/review-ai-summary.ts KEEP_REVIEW_SUMMARY: the summary and its week kept only while the reviews' mark is the one read.
        if (key.startsWith("-- marktmorgen:review-summary-keep:v1\n") && args[0] === "4" && args.length === 10) {
          const [, mark, summary, last, lock, expected, value, seconds, at, mine] = args;
          this.live(mark); this.live(lock);
          const held = this.data.get(mark), locked = this.data.get(lock);
          if ((held !== undefined && typeof held !== "string") || (locked !== undefined && typeof locked !== "string")) throw new Error("WRONGTYPE");
          if ((held ?? "-") !== expected) return 0;
          if (locked !== mine) return 0;
          this.run(["SET", summary, value, "EX", seconds]);
          this.run(["SET", last, at, "EX", seconds]);
          return 1;
        }

        if (key.startsWith("-- marktmorgen:ab-sale:v1\n") && args[0] === "2" && args.length === 6) {
          const [, target, marker, version, rawCents, rawSquare] = args;
          this.live(target); this.live(marker);
          const held = this.data.get(target), mark = this.data.get(marker);
          if (held !== undefined && !(held instanceof Map)) return -1;
          if (mark !== undefined && typeof mark !== "string") return -1;
          if (mark !== undefined) return 0;
          if (version !== "a" && version !== "b") return -1;
          const integer = (raw: string): number | null => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
          const cents = integer(rawCents), square = integer(rawSquare);
          const invalid = () => {
            this.hash(target).set("invalid", "1");
            this.until.set(target, this.now() + 34560000 * 1000);
            return -1;
          };
          if (!cents || !square) return invalid();
          const fields = [`s${version}`, `r${version}`, `q${version}`];
          const additions = [1, cents, square];
          const values: number[] = [];
          for (let i = 0; i < fields.length; i++) {
            const raw = held instanceof Map ? held.get(fields[i]) : undefined;
            const value = raw === undefined ? 0 : integer(raw);
            if (value === null || value > Number.MAX_SAFE_INTEGER - additions[i]) return invalid();
            values.push(value + additions[i]);
          }
          fields.forEach((field, i) => this.hash(target).set(field, String(values[i])));
          this.until.set(target, this.now() + 34560000 * 1000);
          this.data.set(marker, "1");
          this.until.set(marker, this.now() + 3456000 * 1000);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:funnel-save:v1\n") && args[0] === "1" && args.length === 6) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) return -3;
          const exists = held instanceof Map && held.has(args[2]);
          if (args[5] === "new") {
            if (exists) return -2;
            if (held instanceof Map && held.size >= Number(args[4])) return 0;
          } else if (args[5] !== "edit" || !exists) return -2;
          try {
            const incoming = JSON.parse(args[3]);
            if (!incoming || typeof incoming !== "object" || incoming.id !== args[2] || typeof incoming.slug !== "string") return -3;
            if (held instanceof Map) for (const [id, raw] of held) {
              const row = JSON.parse(raw);
              if (!row || typeof row !== "object" || row.id !== id || typeof row.slug !== "string") return -3;
              if (id !== args[2] && row.slug.toLowerCase() === incoming.slug.toLowerCase()) return -1;
            }
          } catch { return -3; }
          this.hash(target).set(args[2], args[3]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:saved-section:v1\n") && args[0] === "1" && args.length === 6) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) return -3;
          const exists = held instanceof Map && held.has(args[2]);
          if (args[5] === "new") {
            if (exists) return -2;
            if (held instanceof Map && held.size >= Number(args[4])) return 0;
          } else if (args[5] !== "edit" || !exists) return -2;
          this.hash(target).set(args[2], args[3]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:funnel-share:v1\n") && args[0] === "2" && args.length === 10) {
          const [, list, lookup, id, meta, rec, sum, bundle, limit, ttl] = args;
          this.live(list);
          this.live(lookup);
          const held = this.data.get(list);
          if (held !== undefined && !(held instanceof Map)) return -3;
          if (this.data.has(lookup) || (held instanceof Map && held.has(id))) return -2;
          if (held instanceof Map && held.size >= Number(limit)) return 0;
          this.hash(list).set(id, meta);
          const record = this.hash(lookup);
          record.set("rec", rec);
          record.set("sum", sum);
          record.set("bundle", bundle);
          this.until.set(lookup, this.now() + Number(ttl) * 1000);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:order-admission:v3\n") && args[0] === "4" && args.length === 12) {
          const [, countKey, openKey, roomKey, heldKey, rawLimit, rawN, rawHour, rawOldest, keep, rawRoom, rawBytes] = args;
          for (const k of [countKey, openKey, roomKey, heldKey]) this.live(k);
          const limit = Number(rawLimit), n = Number(rawN), hour = Number(rawHour), oldest = Number(rawOldest), room = Number(rawRoom), bytes = Number(rawBytes);
          if (![limit, n, hour, oldest, room, bytes].every(Number.isFinite) || n < 1 || bytes < 0) return -1;
          const ledger = this.data.get(roomKey);
          const used = ledger instanceof Map ? Number(ledger.get("#") ?? "0") : 0;
          if (!Number.isFinite(used)) return -1;
          const raw = this.data.get(countKey);
          const counted = raw === undefined ? 0 : Number(raw);
          if (!Number.isFinite(counted)) return -1;
          const sumOf = (target: string) => {
            const hours = this.hash(target);
            let sum = 0;
            for (const [at, value] of [...hours]) {
              const when = Number(at), v = Number(value) || 0;
              if (!Number.isFinite(when) || when < oldest || v <= 0) hours.delete(at);
              else sum += v;
            }
            return hours === undefined ? 0 : sum;
          };
          const open = sumOf(openKey);
          const holding = sumOf(heldKey);
          if (counted + open + n > limit) return 0;
          if (used + holding + bytes > room) return 2;
          const hours = this.hash(openKey), held = this.hash(heldKey);
          hours.set(String(hour), String((Number(hours.get(String(hour))) || 0) + n));
          held.set(String(hour), String((Number(held.get(String(hour))) || 0) + bytes));
          this.until.set(openKey, this.now() + Number(keep) * 1000);
          this.until.set(heldKey, this.now() + Number(keep) * 1000);
          return 1;
        }
        // lib/order-admission.ts MOVE_HELD_ORDERS: the orders held for an unknown window moved into its count in
        // one step, nothing written unless both keys read as whole counts.
        if (key.startsWith("-- marktmorgen:orders-held-move:v1\n") && args[0] === "2" && args.length === 4) {
          const [, pending, count, rawKeep] = args;
          const whole = (raw: string) => raw.length <= 15 && (raw === "0" || /^-?[1-9]\d*$/.test(raw)) ? Number(raw) : null;
          const raw = this.run(["GET", pending]);
          if (raw === null) return 0;
          const n = whole(String(raw));
          if (n === null || n < 0) return -1;
          const have = this.run(["GET", count]);
          if (have !== null && whole(String(have)) === null) return -1;
          const keep = Number(rawKeep);
          if (rawKeep.trim() === "" || !Number.isFinite(keep) || keep < 1) return -1;
          this.run(["DEL", pending]);
          if (n === 0) return 0;
          this.run(["INCRBY", count, n]);
          this.run(["EXPIRE", count, keep]);
          return n;
        }
        if (key.startsWith("-- marktmorgen:order-admission-settle:v2\n") && args[0] === "2" && args.length === 6) {
          const [, openKey, heldKey, field, rawN, rawBytes] = args;
          this.live(openKey);
          this.live(heldKey);
          const n = Number(rawN), bytes = Number(rawBytes);
          const open = this.data.get(openKey);
          if (!(open instanceof Map) || !Number.isFinite(n) || n < 1 || !Number.isFinite(bytes) || bytes < 0) return 0;
          const count = Number(open.get(field)) || 0;
          if (count <= 0) return 0;
          if (count <= n) open.delete(field);
          else open.set(field, String(count - n));
          const held = this.data.get(heldKey);
          if (held instanceof Map) {
            const kept = Number(held.get(field)) || 0;
            if (kept <= bytes) held.delete(field);
            else held.set(field, String(kept - bytes));
          }
          return 1;
        }
        // lib/calendar-sync.ts, KEEP_COPY: the feed's copy written only while the store's calendar settings exist, and
        // only when nobody it names was deleted from the store (their prints in KEYS[3]); one was: the copy goes, 2.
        if (key.startsWith("-- marktmorgen:calendar-copy:v2\n") && args[0] === "3" && args.length >= 6) {
          const [, settings, copy, erased, value, seconds, ...prints] = args;
          this.live(settings);
          this.scriptCalls += 1;
          if (!this.data.has(settings)) return 0;
          if (prints.length) {
            this.scriptCalls += 1;
            const found = this.run(["HMGET", erased, ...prints]) as unknown[];
            if (found.some((one) => one !== null)) {
              this.scriptCalls += 1;
              this.run(["DEL", copy]);
              return 2;
            }
          }
          this.scriptCalls += 1;
          this.run(["SET", copy, value, "EX", seconds]);
          return 1;
        }
        // lib/store-readings.ts, READING_COPY: a reading kept only when nobody it names was deleted from the store;
        // the places of those who were answered, and the copy gone.
        if (key.startsWith("-- marktmorgen:reading-copy:v1\n") && args[0] === "2" && args.length >= 6) {
          const [, copy, erased, value, seconds, ...prints] = args;
          this.scriptCalls += 1;
          const found = this.run(["HMGET", erased, ...prints]) as unknown[];
          const gone = found.flatMap((one, i) => (one !== null ? [i + 1] : []));
          this.scriptCalls += 1;
          if (gone.length) this.run(["DEL", copy]);
          else this.run(["SET", copy, value, "EX", seconds]);
          return gone;
        }
        if (key.startsWith("-- marktmorgen:form-save:v1\n") && args[0] === "1" && args.length === 5) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
          if (held instanceof Map && !held.has(args[2]) && held.size >= Number(args[4])) return 0;
          this.hash(target).set(args[2], args[3]);
          return 1;
        }
        // lib/affiliates.ts AFFILIATE_SWAP: one affiliate's record written only over exactly the text read.
        if (key.startsWith("-- marktmorgen:affiliate-swap:v1\n") && args[0] === "1" && args.length === 5) {
          const [, people, field, expected, next] = args;
          if (this.run(["HGET", people, field]) !== expected) return 0;
          this.run(["HSET", people, field, next]);
          return 1;
        }
        // Models only the explicitly supported application scripts. Not a Lua interpreter.
        if (key.startsWith("-- marktmorgen:crm-deal-move:v2\n") && args[0] === "1" && args.length === 5) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
          const current = held instanceof Map ? held.get(args[2]) : undefined;
          if (current === undefined) return 0;
          if (current !== args[3]) return [-1, new TextEncoder().encode(current).length];
          this.hash(target).set(args[2], args[4]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:flow-queue-if-leased:v1\n") && args[0] === "2" && args.length === 6) {
          const [, lease, queue, member, score, next] = args;
          if (this.run(["ZSCORE", lease, member]) === null) return 0;
          this.run(["ZADD", queue, score, next]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:crm-pipelines-save:v2\n") && args[0] === "1" && args.length === 4) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && typeof held !== "string") throw new Error("WRONGTYPE");
          if ((held ?? "") !== args[2]) return held === undefined ? [-1] : [-1, new TextEncoder().encode(held).length];
          this.data.set(target, args[3]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:crm-deal-save:v2\n") && args[0] === "1" && args.length === 6) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
          const there = held instanceof Map && held.has(args[2]);
          if (!there && args[5] === "edit") return 2;
          if (!there && held instanceof Map && held.size >= Number(args[4])) return 0;
          this.hash(target).set(args[2], args[3]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:crm-tasks-write:v1\n") && args[0] === "1" && args.length === 8) {
          // lib/crm.ts WRITE_PERSON_TASKS: a person's tasks and the store's count, in one step.
          const [, target, person, read, value, added, start, field] = args;
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
          if ((held instanceof Map ? held.get(person) ?? "" : "") !== read) return -1;
          const hash = this.hash(target);
          if (value === "") hash.delete(person);
          else hash.set(person, value);
          const kept = hash.get(field);
          const n = kept !== undefined && /^\d+$/.test(kept) ? Number(kept) : null;
          if (n !== null) hash.set(field, String(Math.max(0, n + Number(added))));
          else if (start !== "") hash.set(field, start);
          else if (kept !== undefined) hash.delete(field);
          if (hash.size === 0) this.data.delete(target);
          return n === null && kept !== undefined ? 2 : 1;
        }
        if (key.startsWith("-- marktmorgen:crm-tasks-count-save:v1\n") && args[0] === "1" && args.length === 4) {
          // lib/crm.ts SAVE_TASK_COUNT: the count saved once made, never over a whole number.
          const [, target, field, value] = args;
          this.live(target);
          const held = this.data.get(target);
          if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
          const kept = held instanceof Map ? held.get(field) : undefined;
          if (kept !== undefined && /^\d+$/.test(kept)) return 0;
          this.hash(target).set(field, value);
          return kept === undefined ? 1 : 2;
        }
        if (key.startsWith("-- marktmorgen:crm-tasks-forget:v1\n") && args[0] === "1" && args.length === 6) {
          // lib/crm.ts FORGET_PERSON_TASKS: a person's tasks deleted, the count moved with them or dropped.
          const [, target, person, read, gone, field] = args;
          this.live(target);
          const held = this.data.get(target);
          if (held === undefined) return ["", 0];
          if (!(held instanceof Map)) throw new Error("WRONGTYPE");
          const value = held.get(person);
          if (value === undefined) return ["", 0];
          held.delete(person);
          const kept = held.get(field);
          const n = kept !== undefined && /^\d+$/.test(kept) ? Number(kept) : null;
          let dropped = 0;
          if (n !== null && value === read) held.set(field, String(Math.max(0, n - Number(gone))));
          else if (kept !== undefined) {
            held.delete(field);
            dropped = 1;
          }
          if (held.size === 0) this.data.delete(target);
          return [value, dropped];
        }
        if (key.startsWith("-- marktmorgen:crm-value-take:v1\n") && args[0] === "1" && args.length === 3) {
          const target = args[1];
          this.live(target);
          const held = this.data.get(target);
          if (held === undefined) return null;
          if (!(held instanceof Map)) throw new Error("WRONGTYPE");
          const value = held.get(args[2]);
          if (value === undefined) return null;
          held.delete(args[2]);
          return value;
        }
        if (key.startsWith("-- marktmorgen:host-claim:v1\n")) return this.hostClaim(args);
        // lib/api-keys.ts RECORD_SWAP: each record written only over exactly the text read; nothing for one gone.
        if (key.startsWith("-- marktmorgen:api-key-record-swap:v1\n") && args[0] === "1" && (args.length - 2) % 3 === 0) {
          const [, list, ...triples] = args;
          const changed: string[] = [];
          for (let i = 0; i + 2 < triples.length; i += 3) {
            if (this.run(["HGET", list, triples[i]]) !== triples[i + 1]) continue;
            this.run(["HSET", list, triples[i], triples[i + 2]]);
            changed.push(triples[i]);
          }
          return changed;
        }
        // lib/api-keys.ts HOLD_SWAP: each field still in the list, whose hold is one of the allowed, takes the new one.
        if (key.startsWith("-- marktmorgen:api-hold-swap:v1\n") && args[0] === "2" && args.length >= 5) {
          const [, holds, list, next, rawCount, ...rest] = args;
          const count = Number(rawCount);
          const fields = rest.slice(0, count);
          const allowed = rest.slice(count);
          const changed: string[] = [];
          for (const field of fields) {
            if (Number(this.run(["HEXISTS", list, field])) !== 1) continue;
            const now = this.run(["HGET", holds, field]);
            if (!allowed.includes(typeof now === "string" ? now : "")) continue;
            this.run(next === "" ? ["HDEL", holds, field] : ["HSET", holds, field, next]);
            changed.push(field);
          }
          return changed;
        }
        if (key.startsWith("-- marktmorgen:decr-to-zero:v1\n") && args[0] === "1" && args.length === 2) {
          this.live(args[1]);
          const n = Number(this.data.get(args[1]) ?? "0") || 0;
          if (n <= 0) return 0;
          this.data.set(args[1], String(n - 1));
          return n - 1;
        }
        if (key.startsWith("-- marktmorgen:lesson-comments-add:v2\n") && args[0] === "4" && args.length === 13) {
          const [, comments, lesson, all, replies, parentId, lessonId, id, raw, score, rawMost, rawRecent, rawLessonMost] = args;
          let count = 0;
          if (parentId !== "") {
            const parentRaw = this.run(["HGET", comments, parentId]);
            if (typeof parentRaw !== "string") return [1, 0, 0, 0, 0];
            try {
              const parent = JSON.parse(parentRaw) as { id?: unknown; l?: unknown; r?: unknown };
              if (parent.id !== parentId || parent.l !== lessonId || (parent.r !== undefined && parent.r !== null)) return [3, 0, 0, 0, 0];
            } catch { return [3, 0, 0, 0, 0]; }
            count = Number(this.run(["HGET", replies, parentId]) ?? 0);
            const most = Number(rawMost);
            if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(most) || most < 1) return [3, 0, 0, 0, 0];
            if (count >= most) return [2, 0, 0, 0, 0];
          } else {
            const lessonCount = Number(this.run(["ZCARD", lesson])), most = Number(rawLessonMost);
            if (!Number.isSafeInteger(lessonCount) || lessonCount < 0 || !Number.isSafeInteger(most) || most < 1) return [3, 0, 0, 0, 0];
            if (lessonCount >= most) return [4, 0, 0, 0, 0];
          }
          const kept = this.run(["HSET", comments, id, raw]);
          const underLesson = this.run(["ZADD", lesson, score, id]);
          const newest = this.run(["ZADD", all, score, id]);
          const trimmed = this.run(["ZREMRANGEBYRANK", all, 0, -Number(rawRecent) - 1]);
          const answers = parentId === "" ? 0 : this.run(["HINCRBY", replies, parentId, 1]);
          return [kept, underLesson, newest, trimmed, answers];
        }
        if (key.startsWith("-- marktmorgen:lesson-comment-thread-delete:v1\n") && args[0] === "4" && args.length === 10) {
          const [, comments, lesson, all, replies, target, lessonId, rawMost, rawEntry, rawStep] = args;
          const raw = this.run(["HGET", comments, target]);
          if (typeof raw !== "string") return [0, 0];
          const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{12}$/.test(value);
          const parsed = (value: string, expected: string): { r: string | null; hidden: boolean } | null => {
            try {
              const row = JSON.parse(value) as { id?: unknown; l?: unknown; b?: unknown; t?: unknown; r?: unknown; h?: unknown };
              if (row.id !== expected || row.l !== lessonId || typeof row.b !== "string" || typeof row.t !== "string") return null;
              if (row.r !== undefined && row.r !== null && !validId(row.r)) return null;
              return { r: typeof row.r === "string" ? row.r : null, hidden: row.h === true };
            } catch { return null; }
          };
          const root = parsed(raw, target);
          if (!root) return [-1, 0];
          const gone: [string, string, boolean][] = [[target, raw, root.hidden]], known = new Set([target]);
          const most = Number(rawMost), entry = Number(rawEntry), step = Number(rawStep);
          if (![most, entry, step].every(Number.isSafeInteger) || most < 1 || entry < 0 || step < 1) return [-1, 0];
          if (root.r === null) {
            const ids = this.zset(lesson).slice().sort((a, b) => a.score - b.score || a.member.localeCompare(b.member)).slice(0, most + 1).map(row => row.member);
            if (ids.length > most) return [-1, 0];
            for (const id of ids) {
              const value = this.run(["HGET", comments, id]);
              if (typeof value !== "string") return [-1, 0];
              const row = parsed(value, id);
              if (!row) return [-1, 0];
              if (row.r === target && !known.has(id)) { known.add(id); gone.push([id, value, row.hidden]); }
            }
          } else {
            const count = Number(this.run(["HGET", replies, root.r]));
            if (!Number.isSafeInteger(count) || count < 1) return [-1, 0];
          }
          const hiddenMark = new TextEncoder().encode(',"h":true').length;
          const freed = gone.reduce((sum, [, value, hidden]) => sum + Math.ceil((new TextEncoder().encode(value).length - (hidden ? hiddenMark : 0) + entry * 4) / step) * step, 0);
          for (const [id] of gone) {
            this.run(["HDEL", comments, id]);
            this.run(["ZREM", lesson, id]);
            this.run(["ZREM", all, id]);
            this.run(["HDEL", replies, id]);
          }
          if (root.r !== null) this.run(["HINCRBY", replies, root.r, -1]);
          return [gone.length, freed];
        }
        if (key.startsWith("-- marktmorgen:lesson-comments-forget:v2\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count);
          const argv = args.slice(1 + count);
          const [comments, all, replies, names, ...lessonKeys] = keys;
          const who = argv[0];
          const lessons = new Map(lessonKeys.map((k, i) => [argv[1 + i], k]));
          for (const k of keys) this.live(k);
          const held = this.data.get(comments);
          const rows = new Map<string, { b?: string; r?: string | null; l?: string }>();
          if (held instanceof Map) for (const [id, raw] of held) {
            try { rows.set(id, JSON.parse(raw)); } catch { /* not a comment */ }
          }
          const tops = new Set([...rows].filter(([, c]) => c.b === who && !c.r).map(([id]) => id));
          const raws = new Map(held instanceof Map ? [...held] : []);
          const gone: string[] = [];
          for (const [id, c] of rows) {
            const parent = c.r ?? null;
            if (c.b !== who && !(parent && tops.has(parent))) continue;
            if (held instanceof Map) held.delete(id);
            this.zset(all).splice(0, this.zset(all).length, ...this.zset(all).filter((e) => e.member !== id));
            this.hash(replies).delete(id);
            const lessonKey = c.l ? lessons.get(c.l) : undefined;
            if (lessonKey) this.zset(lessonKey).splice(0, this.zset(lessonKey).length, ...this.zset(lessonKey).filter((e) => e.member !== id));
            if (parent && !tops.has(parent) && rows.has(parent)) {
              const counts = this.hash(replies);
              counts.set(parent, String((Number(counts.get(parent)) || 0) - 1));
            }
            gone.push(raws.get(id) ?? "");
          }
          const name = this.hash(names).get(who) ?? "";
          this.hash(names).delete(who);
          return [name, gone];
        }
        if (key.startsWith("-- marktmorgen:lesson-comments-hide:v1\n") && args[0] === "1" && args.length === 4) {
          if (this.run(["HEXISTS", args[1], args[2]]) !== 1) return 0;
          this.run(["HSET", args[1], args[2], args[3]]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:lesson-comments-take:v2\n")) {
          const count = Number(args[0]);
          const [comments, all, replies, ...lessonKeys] = args.slice(1, 1 + count);
          const drop = args[1 + count] === "drop";
          const asked = drop ? lessonKeys.flatMap((k) => (this.run(["ZREVRANGE", k, 0, -1]) as string[]).reverse()) : args.slice(2 + count);
          const askedSet = new Set(asked);
          const taken = new Set<string>();
          const tops = new Set<string>();
          const gone: string[] = [];
          const decode = (raw: string): { r?: unknown } | null => {
            try { const c = JSON.parse(raw); return c && typeof c === "object" ? c : null; } catch { return null; }
          };
          for (const id of asked) {
            if (taken.has(id)) continue;
            const raw = this.run(["HGET", comments, id]);
            this.run(["ZREM", all, id]);
            this.run(["HDEL", replies, id]);
            for (const k of lessonKeys) this.run(["ZREM", k, id]);
            if (typeof raw !== "string") continue;
            taken.add(id);
            this.run(["HDEL", comments, id]);
            gone.push(raw);
            const c = decode(raw);
            if (!c) continue;
            const parent = typeof c.r === "string" ? c.r : null;
            if (parent === null) tops.add(id);
            else if (!askedSet.has(parent) && !taken.has(parent) && this.run(["HEXISTS", comments, parent]) === 1) this.run(["HINCRBY", replies, parent, -1]);
          }
          if (tops.size) for (const k of lessonKeys) {
            for (const id of this.zset(k).map((e) => e.member)) {
              const raw = this.run(["HGET", comments, id]);
              if (typeof raw !== "string") continue;
              const c = decode(raw);
              if (!c || typeof c.r !== "string" || !tops.has(c.r)) continue;
              this.run(["HDEL", comments, id]);
              this.run(["HDEL", replies, id]);
              this.run(["ZREM", all, id]);
              this.run(["ZREM", k, id]);
              gone.push(raw);
            }
          }
          if (drop) for (const k of lessonKeys) this.run(["DEL", k]);
          return gone;
        }
        if (key.startsWith("-- marktmorgen:kept-any:v1\n")) {
          // lib/two-step.ts KEEP_ANY: KEYS[1] the list, ARGV[1] a tag, ARGV[2] the most tags, ARGV[3] seconds.
          const [list, tag, most, seconds] = [args[1], args[2], Number(args[3]), Number(args[4])];
          this.live(list);
          const held = this.data.get(list);
          if (held !== undefined && typeof held !== "string") throw new Error("WRONGTYPE");
          let value = held ?? "";
          if (value !== "*" && !value.split(" ").includes(tag)) {
            const n = value.split(" ").filter(Boolean).length;
            value = n >= most ? "*" : value === "" ? tag : `${value} ${tag}`;
          }
          this.data.set(list, value);
          this.until.set(list, this.now() + seconds * 1000);
          return value === "*" ? 0 : 1;
        }
        if (key.startsWith("-- marktmorgen:list-blank:v1\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count);
          const [value, mark] = [args[1 + count], args[2 + count]];
          let n = 0;
          for (const listKey of keys) {
            this.live(listKey);
            if (!this.data.has(listKey)) continue;
            const list = this.list(listKey);
            list.forEach((item, i) => {
              if (item === value) {
                list[i] = mark;
                n += 1;
              }
            });
          }
          return n;
        }
        if (key.startsWith("-- marktmorgen:form-keep:v1\n") && args[0] === "1" && args.length === 4) {
          const listKey = args[1];
          this.live(listKey);
          const list = this.list(listKey);
          list.unshift(args[2]);
          const out: string[] = [];
          while (list.length > Number(args[3])) out.push(list.pop()!);
          return out;
        }
        if (key.startsWith("-- marktmorgen:form-forget:v2\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count);
          const address = args[1 + count];
          const out: (string | number)[] = [];
          keys.forEach((listKey, k) => {
            this.live(listKey);
            if (!this.data.has(listKey)) return;
            const counts = new Map<string, number>();
            const kept = this.list(listKey).filter((raw) => {
              try {
                const value = JSON.parse(raw) as { answers?: Record<string, unknown> };
                const hit = value && typeof value.answers === "object" && value.answers !== null && Object.values(value.answers).some((a) => typeof a === "string" && a.trim().toLowerCase() === address);
                if (hit) counts.set(raw, (counts.get(raw) ?? 0) + 1);
                return !hit;
              } catch {
                return true;
              }
            });
            this.data.set(listKey, kept);
            for (const [raw, n] of counts) out.push(k + 1, raw, n);
          });
          return out;
        }
        // lib/creator-card.ts SAVE_CARD and DROP_CARD: the card and its data-room slot in one step.
        if (key.startsWith("-- marktmorgen:card-save:v1\n") && args[0] === "2" && args.length === 7) {
          const [, room, target, limit, month, size, json] = args;
          const taken = this.storeData([room, limit, "0", month, "s", "card", size]);
          if (Array.isArray(taken) && taken[0] === 1) {
            this.data.set(target, json);
            this.until.delete(target);
          }
          return taken;
        }
        if (key.startsWith("-- marktmorgen:card-drop:v1\n") && args[0] === "2" && args.length === 6) {
          const [, room, target, limit, month, seen] = args;
          const held = this.run(["GET", target]);
          if ((typeof held === "string" ? held : "") !== seen) return [2, 0];
          if (typeof held === "string") this.run(["DEL", target]);
          return this.storeData([room, limit, "1", month, "s", "card", "0"]);
        }
        if (key.startsWith("-- marktmorgen:path-write:v1\n")) {
          const count=Number(args[0]);
          if(!((count===2 && args.length===9)||(count===4 && args.length===12)))return [-1,0];
          const [room,target,boardKey,mapKey]=args.slice(1,1+count);
          const [limit,month,size,expected,create,json,sid]=args.slice(1+count);
          const map=this.data.get(mapKey);
          const shared=this.data.get(boardKey);
          if(count===4 && (!/^[0-9a-f]{32}$/.test(sid) || (map!==undefined && !(map instanceof Map)) || (shared!==undefined && (!Array.isArray(shared) || (shared.length>0 && typeof shared[0]!=="object")))))return [-1,0];
          const oldMember=count===4 && map instanceof Map?map.get(sid):undefined;
          this.live(target);
          const old=this.data.get(target);
          let before:Record<string,unknown>|null=null;
          if(create==="1") { if(old!==undefined)return [-2,0]; if(expected!=="")return [-1,0]; }
          else if(create==="0") {
            if(old===undefined)return [-2,0];
            try { before=JSON.parse(String(old)); if(!before||before.v!==1)return [-1,0]; if((typeof before.r==="string"?before.r:"")!==expected)return [-2,0]; } catch { return [-1,0]; }
          } else return [-1,0];
          let next:Record<string,unknown>;
          try { next=JSON.parse(json); if(!next||next.v!==1||typeof next.r!=="string"||!/^[0-9a-f]{32}$/.test(next.r)||next.r===expected)return [-1,0]; } catch { return [-1,0]; }
          const board=readPathBoard(next.g);
          if(next.g!==undefined && next.g!==null && !board)return [-1,0];
          if(board && count!==4)return [-1,0];
          if(board && before && readPathBoard(before.g) && !oldMember)return [-2,0];
          const extra=count===4?["s","path-board",board?String(PATH_BOARD_ROOM_BYTES):"0"]:[];
          const taken=this.storeData([room,limit,"0",month,"s","path",size,...extra]);
          if(Array.isArray(taken)&&taken[0]===1) {
            this.data.set(target,json);this.until.delete(target);
            if(count===4) {
              if(oldMember)this.run(["ZREM",boardKey,oldMember]);
              if(board) { const member=pathBoardMember(board);this.run(["ZADD",boardKey,board.score,member]);this.run(["HSET",mapKey,sid,member]); }
              else if(map instanceof Map) { map.delete(sid); if(!map.size)this.data.delete(mapKey); }
              const held=this.data.get(boardKey); if(Array.isArray(held)&&!held.length)this.data.delete(boardKey);
            }
          }
          return taken;
        }
        if (key.startsWith("-- marktmorgen:path-forget:v1\n")) {
          const count=Number(args[0]);
          if(!((count===2 && args.length===4)||(count===4 && args.length===7)))return [-1,0];
          const [room,target,boardKey,mapKey]=args.slice(1,1+count);
          const [month,sid]=args.slice(1+count);
          const map=this.data.get(mapKey);
          const shared=this.data.get(boardKey);
          if(count===4 && (!/^[0-9a-f]{32}$/.test(sid) || (map!==undefined && !(map instanceof Map)) || (shared!==undefined && (!Array.isArray(shared) || (shared.length>0 && typeof shared[0]!=="object")))))return [-1,0];
          const oldMember=count===4 && map instanceof Map?map.get(sid):undefined;
          const taken=this.storeData([room,"0","1",month,"s","path","0",...(count===4?["s","path-board","0"]:[])]);
          if(Array.isArray(taken)&&taken[0]===1) {
            this.data.delete(target);this.until.delete(target);
            if(count===4) {
              if(oldMember)this.run(["ZREM",boardKey,oldMember]);
              if(map instanceof Map) { map.delete(sid);if(!map.size)this.data.delete(mapKey); }
              const held=this.data.get(boardKey);if(Array.isArray(held)&&!held.length)this.data.delete(boardKey);
            }
          }
          return taken;
        }
        // lib/campaign-landing-store.ts WRITE_LANDINGS and DROP_LANDINGS: a product's landings and their slot in one step.
        if (key.startsWith("-- marktmorgen:landings-write:v2\n") && args[0] === "3" && args.length === 10) {
          const [, room, target, gone, limit, month, slot, size, expected, json] = args;
          if (this.run(["EXISTS", gone]) === 1) return [4, 0];
          const held = this.run(["GET", target]);
          if ((typeof held === "string" ? held : "") !== expected) return [3, 0];
          const taken = this.storeData([room, limit, json === "" ? "1" : "0", month, "s", slot, json === "" ? "0" : size]);
          if (Array.isArray(taken) && taken[0] === 1) {
            if (json === "") this.run(["DEL", target]);
            else {
              this.data.set(target, json);
              this.until.delete(target);
            }
          }
          return taken;
        }
        if (key.startsWith("-- marktmorgen:landings-drop:v2\n") && args[0] === "3" && args.length === 8) {
          const [, room, target, gone, limit, month, slot, seconds] = args;
          const taken = this.storeData([room, limit, "1", month, "s", slot, "0"]);
          if (!Array.isArray(taken) || taken[0] !== 1) return taken;
          this.run(["DEL", target]);
          this.run(["SET", gone, "1", "EX", seconds]);
          return taken;
        }
        // lib/stock.ts STOCK_ADMIT and STOCK_BIND (513 [PF1], Codex G2's review of #1730, 5 November 2026), step for step.
        if (key.startsWith("-- marktmorgen:stock-admit:v1\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count), argv = args.slice(1 + count);
          const n = Number(argv[0]);
          if (!Number.isInteger(n) || n < 1 || n > 8 || count !== 2 * n || argv.length !== n + 2) return -1;
          const pending = argv[n + 1];
          for (const k of keys) this.live(k);
          let ours = true;
          for (let i = 0; i < n; i += 1) {
            const lock = this.data.get(keys[i]), hold = this.data.get(keys[n + i]);
            // GET and HEXISTS on a key of another type fail the script, as Redis does.
            if (lock !== undefined && typeof lock !== "string") throw new Error("WRONGTYPE");
            if (hold !== undefined && !(hold instanceof Map)) throw new Error("WRONGTYPE");
            if (lock !== argv[1 + i]) ours = false;
            if (!(hold instanceof Map) || !hold.has(pending)) ours = false;
          }
          if (ours) {
            for (let i = 0; i < n; i += 1) this.run(["DEL", keys[i]]);
            return 1;
          }
          for (let i = 0; i < n; i += 1) if (this.data.get(keys[n + i]) instanceof Map) this.run(["HDEL", keys[n + i], pending]);
          return 0;
        }
        if (key.startsWith("-- marktmorgen:stock-bind:v1\n")) {
          const count = Number(args[0]);
          const keys = args.slice(1, 1 + count), argv = args.slice(1 + count);
          const n = Number(argv[0]);
          if (!Number.isInteger(n) || n < 1 || n > 8 || count !== n || argv.length !== 3) return -1;
          for (const k of keys) this.live(k);
          for (const k of keys) {
            const hold = this.data.get(k);
            if (hold !== undefined && !(hold instanceof Map)) throw new Error("WRONGTYPE");
            if (!(hold instanceof Map) || !hold.has(argv[1]) || !hold.has(argv[2])) return 0;
          }
          for (const k of keys) this.run(["HDEL", k, argv[1]]);
          return 1;
        }
        // lib/closing-holds.ts CALL_BUDGET_ONCE: a closing's call budget, set once per ending, step for step (Codex S on #3309).
        if (key.startsWith("-- marktmorgen:closing-call-budget:v1\n") && args[0] === "1" && args.length === 4) {
          const [, work, calls, ending] = args;
          this.live(work);
          const held = this.data.get(work);
          if (held instanceof Map && held.size === 0) this.data.delete(work);
          const type = this.run(["TYPE", work]);
          if (type !== "hash" && type !== "none") return -1;
          if (this.run(["HGET", work, "of"]) === ending) return 0;
          this.run(["DEL", work]);
          this.run(["HSET", work, "calls", calls, "of", ending]);
          return 1;
        }
        if (key.startsWith("-- marktmorgen:store-data:v1\n") && args[0] === "1") return this.storeData(args.slice(1));
        if (key.startsWith("-- marktmorgen:order-write:v1\n")) return this.orderWrite(args);
        if (key.startsWith("-- marktmorgen:recount-page:v1\n") && args[0] === "2") {
          const [state, sums, from, next, ...pairs] = args.slice(1);
          if (pairs.length % 2 !== 0) return -1;
          const st = this.hash(state);
          if (st.get("phase") !== "scan" || st.get("cursor") !== from) return 0;
          for (let i = 0; i < pairs.length; i += 2) if (!/^\d+$/.test(pairs[i + 1])) return -1;
          const sum = this.hash(sums);
          for (let i = 0; i < pairs.length; i += 2) sum.set(pairs[i], String((Number(sum.get(pairs[i])) || 0) + Number(pairs[i + 1])));
          st.set("cursor", next);
          if (next === "0") {
            st.set("phase", "apply");
            st.set("cursor", "0");
          }
          return 1;
        }
        if (key.startsWith("-- marktmorgen:capped-count:v2\n")) return this.cappedCount(args);
        if (key.startsWith("-- marktmorgen:assistant-pool:v1\n")) return this.assistantPool(args);
        if (key.startsWith("-- marktmorgen:studio-demo-door:v2\n")) return this.studioDemo("door", args);
        if (key.startsWith("-- marktmorgen:studio-demo-refuse:v1\n")) return this.studioDemo("refuse", args);
        if (key.startsWith("-- marktmorgen:studio-demo-session-refuse:v1\n")) return this.studioDemo("sessionRefuse", args);
        if (key.startsWith("-- marktmorgen:studio-demo-seed:v1\n")) return this.studioDemo("seed", args);
        if (key.startsWith("-- marktmorgen:studio-demo-take:v1\n")) return this.studioDemo("take", args);
        if (!key.startsWith("-- marktmorgen:form-opportunity:v1\n") || args[0] !== "1" || args.length !== 5) throw new Error("MemoryRedis: unsupported EVAL");
        const target = args[1];
        this.live(target);
        const held = this.data.get(target);
        if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
        const existing = held instanceof Map ? held.get(args[2]) : undefined;
        if (existing !== undefined) return [0, existing];
        if (held instanceof Map && held.size >= Number(args[4])) return [-1, ""];
        this.hash(target).set(args[2], args[3]);
        return [1, args[3]];
      }
      case "SET": {
        const flags = args.slice(1).map((a) => a.toUpperCase());
        // NX is the whole point of a cooldown: it either takes the key or
        // tells the caller somebody already holds it.
        if (flags.includes("NX") && this.data.has(key)) return null;
        if (flags.includes("XX") && !this.data.has(key)) return null;
        this.data.set(key, args[0]);
        // The index is into `flags`, which starts one past the value, so the
        // seconds have to be read from `flags` too. Reading them from `args`
        // gives NaN, the key never expires, and every test about a cooldown
        // passes for the wrong reason.
        const at = flags.indexOf("EX");
        const seconds = at >= 0 ? Number(flags[at + 1]) : NaN;
        if (Number.isFinite(seconds)) this.until.set(key, this.now() + seconds * 1000);
        else this.until.delete(key);
        return "OK";
      }
      case "EXPIRE":
        if (!this.data.has(key)) return 0;
        this.until.set(key, this.now() + Number(args[0]) * 1000);
        return 1;
      case "TTL": {
        if (!this.data.has(key)) return -2;
        const ends = this.until.get(key);
        if (ends === undefined) return -1;
        return Math.max(0, Math.ceil((ends - this.now()) / 1000));
      }
      case "PEXPIRE":
        if (!this.data.has(key)) return 0;
        this.until.set(key, this.now() + Number(args[0]));
        return 1;
      case "EXPIREAT":
        if (!this.data.has(key)) return 0;
        this.until.set(key, Number(args[0]) * 1000);
        return 1;
      case "PEXPIRETIME": {
        // When the key ends, in ms since the epoch: -1 for none, -2 for a key that is not there (lib/backup-export.ts).
        if (!this.data.has(key)) return -2;
        return this.until.get(key) ?? -1;
      }
      case "PTTL": {
        if (!this.data.has(key)) return -2;
        const ends = this.until.get(key);
        if (ends === undefined) return -1;
        return Math.max(0, ends - this.now());
      }
      case "INCRBY":
      case "DECRBY": {
        // Returns the new total, which is how lib/delivery.ts knows the
        // exact delivery that took a store past its allowance.
        const held = this.data.get(key);
        const by = (Number(args[0]) || 0) * (name === "DECRBY" ? -1 : 1);
        const next = (typeof held === "string" ? Number(held) || 0 : 0) + by;
        this.data.set(key, String(next));
        return next;
      }
      case "INCR":
      case "DECR": {
        const held = this.data.get(key);
        const next = (typeof held === "string" ? Number(held) || 0 : 0) + (name === "DECR" ? -1 : 1);
        this.data.set(key, String(next));
        return next;
      }
      case "GET": {
        const held = this.data.get(key);
        if (held === undefined) return null;
        if (typeof held !== "string") throw new Error("WRONGTYPE");
        return held;
      }
      case "PERSIST":
        // Keeps a key for good: 1 when it had an expiry to take off.
        return this.data.has(key) && this.until.delete(key) ? 1 : 0;
      case "MGET": {
        // Several keys read at once, each as GET would answer it.
        return rest.map(String).map((name) => {
          this.live(name);
          const held = this.data.get(name);
          return typeof held === "string" ? held : null;
        });
      }
      case "GETDEL": {
        // Read once and gone: what a consent's state is taken with.
        const held = this.data.get(key);
        if (typeof held !== "string") return null;
        this.data.delete(key);
        this.until.delete(key);
        return held;
      }
      case "DEL": {
        // DEL takes several keys.
        let gone = 0;
        for (const one of [key, ...args]) if (this.data.delete(one)) gone += 1;
        return gone;
      }
      case "EXISTS":
        return this.data.has(key) ? 1 : 0;
      case "DUMP": {
        // A stand-in for Redis's own serialized value (lib/backup-export.ts): the value and its type, never the key
        // name or its time to live, as DUMP's is; RESTORE below is the only reader of it. Null for a missing key.
        const held = this.data.get(key);
        if (held === undefined) return null;
        const t = typeof held === "string" ? "string" : held instanceof Map ? "hash" : held instanceof Set ? "set" : held.length && typeof held[0] === "object" ? "zset" : "list";
        const v = held instanceof Map || held instanceof Set ? [...held] : held;
        return `\u0000MMDUMP1${JSON.stringify({ t, v })}`;
      }
      case "RESTORE": {
        // RESTORE key ttl payload [REPLACE] [ABSTTL]: refused for a key that is there without REPLACE (BUSYKEY).
        const [ttlRaw, payload, ...flags] = args;
        const options = flags.map((f) => f.toUpperCase());
        if (this.data.has(key) && !options.includes("REPLACE")) throw new Error("BUSYKEY Target key name already exists.");
        const ttl = Number(ttlRaw);
        if (!Number.isSafeInteger(ttl) || ttl < 0 || typeof payload !== "string" || !payload.startsWith("\u0000MMDUMP1")) throw new Error("ERR DUMP payload version or checksum are wrong");
        const { t, v } = JSON.parse(payload.slice("\u0000MMDUMP1".length)) as { t: string; v: unknown };
        const entry: Entry =
          t === "string" ? (v as string)
          : t === "hash" ? new Map(v as [string, string][])
          : t === "set" ? new Set(v as string[])
          : (v as Entry);
        this.data.set(key, entry);
        this.until.delete(key);
        if (ttl > 0) this.until.set(key, options.includes("ABSTTL") ? ttl : this.now() + ttl);
        return "OK";
      }
      case "TYPE": {
        // As Redis names them, for a test that walks every key (tests/erasure-world.ts).
        const held = this.data.get(key);
        if (held === undefined) return "none";
        if (typeof held === "string") return "string";
        if (held instanceof Map) return "hash";
        if (held instanceof Set) return "set";
        if (Array.isArray(held) && held.length && typeof held[0] === "object") return "zset";
        return Array.isArray(held) ? "list" : "none";
      }

      case "RPUSH": {
        const list = this.list(key);
        list.push(...args);
        return list.length;
      }
      case "LPUSH": {
        // Each value goes to the front in turn, as Redis does it: the last
        // one named ends up first.
        const list = this.list(key);
        for (const value of args) list.unshift(value);
        return list.length;
      }
      case "LTRIM": {
        const list = this.list(key);
        const [from, to] = [Number(args[0]), Number(args[1])];
        const start = from < 0 ? Math.max(0, list.length + from) : from;
        const end = to < 0 ? list.length + to : to;
        this.data.set(key, list.slice(start, end + 1));
        return "OK";
      }
      case "LRANGE": {
        const list = this.list(key);
        const [from, to] = [Number(args[0]), Number(args[1])];
        const start = from < 0 ? Math.max(0, list.length + from) : from;
        const end = to < 0 ? list.length + to : to;
        return list.slice(start, end + 1);
      }
      case "LREM": {
        // LREM key count value: count 0 takes every one, as the erasures use it.
        if (!this.data.has(key)) return 0;
        const list = this.list(key);
        const [count, value] = [Number(args[0]), args[1]];
        let gone = 0;
        const kept = list.filter((item) => {
          if (item === value && (count === 0 || gone < Math.abs(count))) {
            gone += 1;
            return false;
          }
          return true;
        });
        this.data.set(key, kept);
        return gone;
      }
      case "STRLEN": {
        const held = this.data.get(key);
        return typeof held === "string" ? Buffer.byteLength(held, "utf8") : 0;
      }
      case "ZSCAN": {
        // ZSCAN key cursor [COUNT n]: everything at once, member and score, the cursor back at "0", as HSCAN does.
        const flat: string[] = [];
        for (const e of this.zset(key)) flat.push(e.member, String(e.score));
        return ["0", flat];
      }
      case "LLEN":
        return this.data.has(key) ? this.list(key).length : 0;
      case "LINDEX": {
        if (!this.data.has(key)) return null;
        const list = this.list(key);
        const at = Number(args[0]);
        return list[at < 0 ? list.length + at : at] ?? null;
      }

      case "HSET": {
        const hash = this.hash(key);
        for (let i = 0; i + 1 < args.length; i += 2) hash.set(args[i], args[i + 1]);
        return 1;
      }
      case "HSETNX": {
        const hash = this.hash(key);
        if (hash.has(args[0])) return 0;
        hash.set(args[0], args[1]);
        return 1;
      }
      case "HGET":
        return this.hash(key).get(args[0]) ?? null;
      case "HEXISTS":
        return this.hash(key).has(args[0]) ? 1 : 0;
      case "HMGET":
        return args.map((field) => this.hash(key).get(field) ?? null);
      case "HDEL": {
        const hash = this.hash(key);
        let gone = 0;
        for (const field of args) if (hash.delete(field)) gone += 1;
        return gone;
      }
      case "HGETALL": {
        const flat: string[] = [];
        for (const [field, value] of this.hash(key)) flat.push(field, value);
        return flat;
      }
      case "HKEYS":
        return [...this.hash(key).keys()];
      case "HVALS":
        return [...this.hash(key).values()];
      case "HLEN":
        return this.hash(key).size;
      case "SCAN": {
        // SCAN cursor [MATCH pattern] [COUNT n]: here the "key" is the cursor.
        // Every match at once, with the cursor back at "0", as HSCAN does.
        const flags = args.map((a) => a.toUpperCase());
        const at = flags.indexOf("MATCH");
        const pattern = at >= 0 ? args[at + 1] : "*";
        const matcher = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        for (const k of [...this.data.keys()]) this.live(k);
        const found = [...this.data.keys()].filter((k) => matcher.test(k));
        return ["0", found];
      }
      case "HSCAN": {
        // HSCAN key cursor [COUNT n]. COUNT is only a hint in Redis, so
        // answering everything at once with the cursor back at "0" is a reply
        // a real server may give; a caller that pages correctly handles both.
        const flat: string[] = [];
        for (const [field, value] of this.hash(key)) flat.push(field, value);
        return ["0", flat];
      }
      case "HINCRBY": {
        const hash = this.hash(key);
        const next = (Number(hash.get(args[0])) || 0) + Number(args[1]);
        hash.set(args[0], String(next));
        return next;
      }

      case "SADD": {
        const set = this.set(key);
        let added = 0;
        for (const one of args) if (!set.has(one)) { set.add(one); added += 1; }
        return added;
      }
      // A count of distinct things, kept by the real one as an estimate in a
      // few kilobytes. Here it is a plain set, so it is exact: what matters
      // to the code that uses it is that something new answers 1.
      case "PFADD": {
        const set = this.set(key);
        let changed = 0;
        for (const one of args) if (!set.has(one)) { set.add(one); changed = 1; }
        return changed;
      }
      case "PFCOUNT": {
        const seen = new Set<string>(this.set(key));
        for (const other of args) for (const one of this.set(other)) seen.add(one);
        return seen.size;
      }
      case "SREM": {
        const set = this.set(key);
        let gone = 0;
        for (const one of args) if (set.delete(one)) gone += 1;
        return gone;
      }
      case "SISMEMBER":
        return this.set(key).has(args[0]) ? 1 : 0;
      case "SMISMEMBER": {
        const members = this.set(key);
        return args.map((member) => (members.has(member) ? 1 : 0));
      }
      case "SMEMBERS":
        return [...this.set(key)];
      case "SRANDMEMBER": {
        // With a positive count, as Redis answers it: that many distinct members at most (the order is Redis's own).
        const count = Number(args[0]);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("ERR value is not an integer or out of range");
        return [...this.set(key)].slice(0, count);
      }
      case "SUNION": {
        // Read without making any key, as Redis does; a key of another kind is refused.
        const out = new Set<string>();
        for (const one of [key, ...args]) {
          this.live(one);
          const held = this.data.get(one);
          if (held === undefined) continue;
          if (!(held instanceof Set)) throw new Error("WRONGTYPE");
          for (const member of held) out.add(member);
        }
        return [...out];
      }
      case "SCARD":
        return this.set(key).size;
      case "SSCAN":
        // Every member at once, with the cursor back at "0", as SCAN does here.
        return ["0", [...this.set(key)]];
      case "SPOP": {
        const set = this.set(key);
        const first = [...set][0];
        if (first === undefined) return null;
        set.delete(first);
        return first;
      }

      case "ZADD": {
        const z = this.zset(key);
        // Flags before the first score, in any order, as Redis reads them. "NX": a member already there keeps the
        // score it has. "XX": only a member already there is moved. "CH": count the members changed too.
        let flags = 0;
        while (flags < args.length && ["NX", "XX", "CH"].includes(String(args[flags]).toUpperCase())) flags += 1;
        const set = new Set(args.slice(0, flags).map((flag) => String(flag).toUpperCase()));
        const onlyNew = set.has("NX");
        const onlyOld = set.has("XX");
        const pairs = args.slice(flags);
        // Redis's answer: the members added, or with CH the members added or whose score changed.
        let added = 0;
        let changed = 0;
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const score = Number(pairs[i]);
          const member = pairs[i + 1];
          const at = z.findIndex((e) => e.member === member);
          if (at >= 0) {
            if (!onlyNew && z[at].score !== score) {
              z[at].score = score;
              changed += 1;
            }
          } else if (!onlyOld) {
            z.push({ score, member });
            added += 1;
          }
        }
        z.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        return set.has("CH") ? added + changed : added;
      }
      case "ZREM": {
        const z = this.zset(key);
        let gone = 0;
        for (const member of args) {
          const at = z.findIndex((e) => e.member === member);
          if (at >= 0) { z.splice(at, 1); gone += 1; }
        }
        return gone;
      }
      case "ZREMRANGEBYSCORE": {
        // Inclusive on both ends, as Redis is without "(".
        const z = this.zset(key);
        const low = args[0] === "-inf" ? -Infinity : Number(args[0]);
        const high = args[1] === "+inf" ? Infinity : Number(args[1]);
        let gone = 0;
        for (let i = z.length - 1; i >= 0; i -= 1) {
          if (z[i].score >= low && z[i].score <= high) { z.splice(i, 1); gone += 1; }
        }
        return gone;
      }
      case "ZCARD":
        return this.zset(key).length;
      case "ZSCORE": {
        const found = this.zset(key).find((e) => e.member === args[0]);
        return found ? String(found.score) : null;
      }
      case "ZREMRANGEBYRANK": {
        const z = this.zset(key);
        const [from, to] = [Number(args[0]), Number(args[1])];
        const start = from < 0 ? Math.max(0, z.length + from) : from;
        const end = to < 0 ? z.length + to : to;
        if (end < start) return 0;
        const gone = z.splice(start, end - start + 1);
        return gone.length;
      }
      case "ZCOUNT": {
        const edge = (raw: string) => {
          if (raw === "-inf") return { value: -Infinity, open: false };
          if (raw === "+inf") return { value: Infinity, open: false };
          if (raw.startsWith("(")) return { value: Number(raw.slice(1)), open: true };
          return { value: Number(raw), open: false };
        };
        const from = edge(args[0]);
        const to = edge(args[1]);
        return this.zset(key).filter(
          (e) => (from.open ? e.score > from.value : e.score >= from.value) && (to.open ? e.score < to.value : e.score <= to.value),
        ).length;
      }
      case "ZRANGEBYSCORE": {
        const z = this.zset(key);
        // "(5" means "after 5", which is how the room asks for what is new.
        const edge = (raw: string) => {
          if (raw === "-inf") return { value: -Infinity, open: false };
          if (raw === "+inf") return { value: Infinity, open: false };
          if (raw.startsWith("(")) return { value: Number(raw.slice(1)), open: true };
          return { value: Number(raw), open: false };
        };
        const from = edge(args[0]);
        const to = edge(args[1]);
        const page = z.filter(
          (e) =>
            (from.open ? e.score > from.value : e.score >= from.value) &&
            (to.open ? e.score < to.value : e.score <= to.value),
        );
        const flags = args.map((a) => a.toUpperCase());
        const at = flags.indexOf("LIMIT");
        const limited = at >= 0 ? page.slice(Number(args[at + 1]), Number(args[at + 1]) + Number(args[at + 2])) : page;
        if (flags.includes("WITHSCORES")) return limited.flatMap((e) => [e.member, String(e.score)]);
        return limited.map((e) => e.member);
      }
      case "ZREVRANGEBYSCORE": {
        // Note the order: max first, then min, the reverse of ZRANGEBYSCORE.
        // Getting that round the wrong way gives an empty answer rather than
        // an error, so a search would quietly find nothing and every check
        // about it would pass for the wrong reason.
        const edge = (raw: string) => {
          if (raw === "-inf") return { value: -Infinity, open: false };
          if (raw === "+inf") return { value: Infinity, open: false };
          if (raw.startsWith("(")) return { value: Number(raw.slice(1)), open: true };
          return { value: Number(raw), open: false };
        };
        const to = edge(args[0]);
        const from = edge(args[1]);
        const page = [...this.zset(key)]
          .reverse()
          .filter(
            (e) =>
              (from.open ? e.score > from.value : e.score >= from.value) &&
              (to.open ? e.score < to.value : e.score <= to.value),
          );
        const flags = args.map((a) => a.toUpperCase());
        const at = flags.indexOf("LIMIT");
        const limited = at >= 0 ? page.slice(Number(args[at + 1]), Number(args[at + 1]) + Number(args[at + 2])) : page;
        if (flags.includes("WITHSCORES")) return limited.flatMap((e) => [e.member, String(e.score)]);
        return limited.map((e) => e.member);
      }
      case "ZINTERSTORE": {
        // ZINTERSTORE dest numkeys key... [AGGREGATE MAX]. The destination is
        // `key`; the sources follow the count.
        const howMany = Number(args[0]);
        const sources = args.slice(1, 1 + howMany);
        const flags = args.map((a) => a.toUpperCase());
        const how = flags.indexOf("AGGREGATE") >= 0 ? flags[flags.indexOf("AGGREGATE") + 1] : "SUM";
        const [firstKey, ...restKeys] = sources;
        for (const one of sources) this.live(one);
        const held = new Map<string, number>();
        for (const entry of this.zset(firstKey ?? "")) held.set(entry.member, entry.score);
        for (const other of restKeys) {
          const theirs = new Map(this.zset(other).map((e) => [e.member, e.score]));
          for (const [member, score] of [...held]) {
            const found = theirs.get(member);
            if (found === undefined) {
              held.delete(member);
              continue;
            }
            held.set(member, how === "MAX" ? Math.max(score, found) : how === "MIN" ? Math.min(score, found) : score + found);
          }
        }
        const made = [...held].map(([member, score]) => ({ score, member }));
        made.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        this.data.set(key, made);
        this.until.delete(key);
        // Redis answers with how many are in the set it just made, which is
        // what the search reads its total from.
        return made.length;
      }
      case "ZINCRBY": {
        const z = this.zset(key);
        const by = Number(args[0]);
        const member = args[1];
        const at = z.findIndex((e) => e.member === member);
        const score = (at >= 0 ? z[at].score : 0) + by;
        if (at >= 0) z[at].score = score;
        else z.push({ score, member });
        z.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        this.data.set(key, z);
        return String(score);
      }
      case "ZUNIONSTORE": {
        // ZUNIONSTORE dest numkeys key... — scores summed, as Redis does by default.
        const howMany = Number(args[0]);
        const sources = args.slice(1, 1 + howMany);
        const held = new Map<string, number>();
        for (const one of sources) {
          this.live(one);
          for (const entry of this.zset(one)) held.set(entry.member, (held.get(entry.member) ?? 0) + entry.score);
        }
        const made = [...held].map(([member, score]) => ({ score, member }));
        made.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        this.data.set(key, made);
        this.until.delete(key);
        return made.length;
      }
      case "ZREVRANK": {
        const z = [...this.zset(key)].reverse();
        const at = z.findIndex((e) => e.member === args[0]);
        return at >= 0 ? at : null;
      }
      case "ZREVRANGE": {
        const z = [...this.zset(key)].reverse();
        const [from, to] = [Number(args[0]), Number(args[1])];
        const start = from < 0 ? Math.max(0, z.length + from) : from;
        const end = to < 0 ? z.length + to : to;
        const page = z.slice(start, end + 1);
        if (args.map((a) => a.toUpperCase()).includes("WITHSCORES")) {
          return page.flatMap((e) => [e.member, String(e.score)]);
        }
        return page.map((e) => e.member);
      }

      default:
        throw new Error(`MemoryRedis does not implement ${name}`);
    }
  }

  /**
   * The host claim script (lib/host-claims.ts, CLAIM_HOST_TIMES), modelled
   * step for step: the same refusals, in the same order, writing nothing
   * unless every host's time is free. scripts/test_host_claims_redis.py runs
   * the script itself against a real Redis.
   */
  /** lib/store-data.ts, TAKE_DATA: the same steps, in the same order. */
  /** Whether a key holds anything: a read here makes an empty one, which Redis never keeps. */
  private present(key: string): boolean {
    this.live(key);
    const held = this.data.get(key);
    if (held === undefined) return false;
    if (typeof held === "string") return true;
    return held instanceof Map || held instanceof Set ? held.size > 0 : held.length > 0;
  }

  /** What Redis's TYPE would say of a key, an empty one being none. */
  private typeOf(key: string): string {
    if (!this.present(key)) return "none";
    return String(this.run(["TYPE", key]));
  }

  /**
   * lib/order-data.ts, ORDER_WRITE: each command run as Redis runs it, and
   * charged what it added, the way the script measures it (UTF-8 bytes).
   */
  private orderWrite(args: string[]): unknown {
    const count = Number(args[0]);
    const keys = args.slice(1, 1 + count);
    const argv = args.slice(1 + count);
    const allowed = new Set(["SET", "HSET", "HSETNX", "HINCRBY", "SADD", "ZADD", "ZINCRBY", "RPUSH", "LPUSH", "INCR", "INCRBY", "DECR", "DECRBY", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "DEL", "HDEL", "SREM", "ZREM"]);
    const n = Number(argv[0]);
    if (!Number.isInteger(n) || n < 1 || n > 48) return [-1];
    const plan: { name: string; key: string; args: string[] }[] = [];
    let i = 1;
    for (let c = 0; c < n; c += 1) {
      const name = argv[i];
      const k = Number(argv[i + 1]);
      const argc = Number(argv[i + 2]);
      if (!allowed.has(name) || !Number.isInteger(k) || k < 2 || !keys[k - 1] || !Number.isInteger(argc) || argc < 0 || i + 2 + argc > argv.length - 1) return [-1];
      plan.push({ name, key: keys[k - 1], args: argv.slice(i + 3, i + 3 + argc) });
      i += 3 + argc;
    }
    if (i !== argv.length) return [-1];
    const bytes = (text: string) => Buffer.byteLength(text, "utf8");
    const existed = new Map<string, boolean>();
    let grown = 0;
    const replies: unknown[] = [];
    for (const { name, key, args: rest } of plan) {
      if (!existed.has(key)) existed.set(key, this.present(key));
      const t = this.typeOf(key);
      const strlen = () => (this.typeOf(key) === "string" ? bytes(String(this.data.get(key))) : 0);
      const field = (f: string) => (this.typeOf(key) === "hash" && (this.data.get(key) as Map<string, string>).has(f) ? bytes((this.data.get(key) as Map<string, string>).get(f)!) : null);
      const member = (m: string) => {
        const held = this.typeOf(key);
        if (held === "set") return (this.data.get(key) as Set<string>).has(m);
        if (held === "zset") return (this.data.get(key) as { member: string }[]).some((e) => e.member === m);
        return false;
      };
      let before: number | Map<string, number | null> | Map<string, boolean> = 0;
      if (name === "SET" || name === "INCR" || name === "INCRBY" || name === "DECR" || name === "DECRBY") before = strlen();
      else if ((name === "HSET" || name === "HSETNX") && (t === "hash" || t === "none")) {
        const fields = new Map<string, number | null>();
        for (let j = 0; j + 1 < rest.length; j += 2) if (!fields.has(rest[j])) fields.set(rest[j], field(rest[j]));
        before = fields;
      } else if (name === "HINCRBY" && (t === "hash" || t === "none")) before = new Map([[rest[0], field(rest[0])]]);
      else if (name === "SADD" && (t === "set" || t === "none")) before = new Map(rest.map((m) => [m, member(m)]));
      else if ((name === "ZADD" || name === "ZINCRBY") && (t === "zset" || t === "none")) {
        const members: string[] = [];
        if (name === "ZINCRBY") members.push(rest[1]);
        else {
          let j = 0;
          while (rest[j] !== undefined && /^[A-Z]+$/.test(rest[j].toUpperCase())) j += 1;
          for (; rest[j + 1] !== undefined; j += 2) members.push(rest[j + 1]);
        }
        before = new Map(members.map((m) => [m, member(m)]));
      }
      let reply: unknown;
      try {
        if ((name === "HSET" || name === "HSETNX" || name === "HINCRBY") && t !== "hash" && t !== "none") throw new Error("WRONGTYPE");
        if (name === "SADD" && t !== "set" && t !== "none") throw new Error("WRONGTYPE");
        reply = this.run([name, key, ...rest]);
        if (name === "HSET") reply = (before as Map<string, number | null>).size === 0 ? 0 : [...(before as Map<string, number | null>).values()].filter((v) => v === null).length;
      } catch (error) {
        replies.push(`\u0000order-write-error:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      replies.push(reply === undefined ? null : reply);
      if (name === "SET" || name === "INCR" || name === "INCRBY" || name === "DECR" || name === "DECRBY") grown += Math.max(0, strlen() - (before as number));
      else if (name === "HSET" || name === "HSETNX" || name === "HINCRBY") {
        for (const [f, old] of before as Map<string, number | null>) {
          const now = field(f);
          if (now === null) continue;
          grown += old === null ? bytes(f) + now + 64 : Math.max(0, now - old);
        }
      } else if (name === "SADD" || name === "ZADD" || name === "ZINCRBY") {
        for (const [m, was] of before as Map<string, boolean>) if (!was && member(m)) grown += name === "SADD" ? bytes(m) + 64 : bytes(m) + 8 + 128;
      } else if (name === "RPUSH" || name === "LPUSH") for (const v of rest) grown += bytes(v) + 64;
    }
    for (const [key, was] of existed) if (!was && this.present(key)) grown += bytes(key) + 96;
    const charged = Math.ceil((grown * 5) / 4 / 16) * 16;
    if (charged > 0) {
      const room = this.hash(keys[0]);
      const old = Number(room.get("o") ?? "0") || 0;
      const total = Number(room.get("#") ?? "0") || 0;
      room.set("o", String(Math.max(old, 0) + charged));
      room.set("#", String(Math.max(total, 0) + charged + (old <= 0 ? 64 : 0)));
    }
    return [charged, ...replies];
  }

  private storeData(args: string[]): unknown {
    const [target, rawLimit, always, month, ...rest] = args;
    this.live(target);
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit < 0 || !/^\d{4}-\d{2}$/.test(month ?? "") || rest.length % 3 !== 0) return [-1, 0];
    const held = this.data.get(target);
    if (held !== undefined && !(held instanceof Map)) throw new Error("WRONGTYPE");
    const room = this.hash(target);
    let total = Number(room.get("#") ?? "0");
    if (!Number.isFinite(total)) return [-1, 0];
    for (let i = 0; i < rest.length; i += 3) {
      const [mode, slot, raw] = rest.slice(i, i + 3);
      if (!Number.isFinite(Number(raw)) || slot === "#" || slot === "~" || slot === "" || (mode !== "s" && mode !== "a")) return [-1, total];
      if (slot.startsWith("~") && (mode !== "a" || !/^\d{4}-\d{2}$/.test(slot.slice(1)) || slot.slice(1) < month)) return [-1, total];
    }
    const months = new Set<string>();
    let relist = false;
    for (const m of (room.get("~") ?? "").split(",").filter(Boolean)) {
      if (m < month) {
        const held = Number(room.get(`~${m}`) ?? "0") || 0;
        if (held > 0) total -= held + 64;
        room.delete(`~${m}`);
        relist = true;
      } else months.add(m);
    }
    if (total < 0) total = 0;
    const keep = () => {
      if (relist) {
        const list = [...months].sort();
        if (list.length) room.set("~", list.join(","));
        else room.delete("~");
      }
      room.set("#", String(total));
    };
    const now = new Map<string, number>();
    let delta = 0;
    for (let i = 0; i < rest.length; i += 3) {
      const [mode, slot, raw] = rest.slice(i, i + 3);
      const n = Number(raw);
      if (slot.startsWith("~")) {
        const m = slot.slice(1);
        if (!months.has(m)) {
          months.add(m);
          relist = true;
        }
      }
      const old = now.has(slot) ? now.get(slot)! : Number(room.get(slot) ?? "0") || 0;
      let next = mode === "s" ? n : old + n;
      if (next < 0) next = 0;
      next = Math.floor(next);
      now.set(slot, next);
      delta += next - old;
      if (old === 0 && next > 0) delta += 64;
      else if (old > 0 && next === 0) delta -= 64;
    }
    if (delta > 0 && always !== "1" && total + delta > limit) {
      keep();
      return [0, total];
    }
    for (const [slot, next] of now) {
      if (next > 0) room.set(slot, String(next));
      else room.delete(slot);
    }
    total = Math.max(0, total + delta);
    keep();
    return [1, total];
  }

  /**
   * lib/studio-demo.ts: the demo's door (the day and the address) counted, a refusal counted for the
   * address and the day or in a live session's record, a session's record and drafts made, and one action
   * counted, step by step as each script runs them, with the commands run
   * inside counted in scriptCalls.
   */
  private studioDemo(kind: "door" | "refuse" | "sessionRefuse" | "seed" | "take", args: string[]): unknown {
    const n = Number(args[0]);
    const keys = args.slice(1, 1 + n);
    const argv = args.slice(1 + n);
    if (!Number.isInteger(n) || n < 1 || keys.length !== n) throw new Error("ERR studio-demo: arguments");
    for (const k of keys) this.live(k);
    const field = (hash: Map<string, string> | undefined, name: string) => hash?.get(name);
    const digits = (value: string | undefined) => (value === undefined ? null : /^\d{1,15}$/.test(value) ? Number(value) : -1);
    const held = this.data.get(keys[0]);
    if (held !== undefined && !(held instanceof Map) && kind !== "seed") throw new Error("WRONGTYPE");
    const hash = held instanceof Map ? held : undefined;
    if (kind === "sessionRefuse") {
      // KEYS[1] the session's record; ARGV the session's refusals cap. Never makes a key.
      this.scriptCalls += 1;
      if (!hash || hash.get("expiresAt") === undefined) return 0;
      const r = digits(field(hash, "refused")) ?? 0;
      if (r < 0) return -1;
      if (r >= Number(argv[0])) return -4;
      hash.set("refused", String(r + 1));
      this.scriptCalls += 1;
      return 1;
    }
    if (kind === "refuse") {
      // KEYS[1] the day's addresses; ARGV the address's refusals field, the day's cap, the address's cap, the end (s).
      this.scriptCalls += 1;
      const [mine, dayCap, addressCap, end] = [argv[0], Number(argv[1]), Number(argv[2]), Number(argv[3])];
      const [r, q] = ["refused", mine].map((name) => digits(field(hash, name)) ?? 0);
      if (r < 0 || q < 0) return -1;
      if (r >= dayCap) return -2;
      if (q >= addressCap) return -4;
      const addresses = this.hash(keys[0]);
      addresses.set("refused", String(r + 1));
      addresses.set(mine, String(q + 1));
      this.until.set(keys[0], end * 1000);
      this.scriptCalls += 3;
      return 1;
    }
    if (kind === "door") {
      this.scriptCalls += 1;
      const [s, c, u] = ["sessions", "commands", "sent"].map((name) => digits(field(hash, name)) ?? 0);
      if (s < 0 || c < 0 || u < 0) return [-1, 0, 0];
      const [sessionsCap, commandsCap, worst, start, keep, refusalsCap] = argv.slice(0, 6).map(Number);
      const [addressField, addressCap, addressEnd, refusalsField, addressRefusalsCap] = [argv[6], Number(argv[7]), Number(argv[8]), argv[9], Number(argv[10])];
      const addresses = this.data.get(keys[1]);
      if (addresses !== undefined && !(addresses instanceof Map)) throw new Error("WRONGTYPE");
      this.scriptCalls += 1;
      const byAddress = addresses instanceof Map ? addresses : undefined;
      const [r, a, q] = ["refused", addressField, refusalsField].map((name) => digits(field(byAddress, name)) ?? 0);
      if (r < 0 || a < 0 || q < 0) return [-1, 0, 0];
      if (r >= refusalsCap) return [-2, s, c];
      if (q >= addressRefusalsCap) return [-4, s, c];
      const refuse = (code: number) => {
        const counts = this.hash(keys[1]);
        counts.set("refused", String(r + 1));
        counts.set(refusalsField, String(q + 1));
        this.until.set(keys[1], addressEnd * 1000);
        this.scriptCalls += 3;
        return [code, s, c];
      };
      if (a >= addressCap) return refuse(-3);
      if (s >= sessionsCap || c + worst > commandsCap) return refuse(0);
      const day = this.hash(keys[0]);
      day.set("sessions", String(s + 1));
      day.set("commands", String(c + worst));
      day.set("sent", String(u + start));
      this.until.set(keys[0], this.now() + keep * 1000);
      this.hash(keys[1]).set(addressField, String(a + 1));
      this.until.set(keys[1], addressEnd * 1000);
      this.scriptCalls += 6;
      return [1, s + 1, c + worst];
    }
    if (kind === "seed") {
      this.scriptCalls += 1;
      if (held !== undefined) return 0;
      const [end, day, startedAt, expiresAt, bytes, ...values] = argv;
      if (values.length !== n - 1) throw new Error("ERR studio-demo: arguments");
      this.data.set(keys[0], new Map([["day", day], ["startedAt", startedAt], ["expiresAt", expiresAt], ["actions", "0"], ["bytes", bytes]]));
      this.until.set(keys[0], Number(end) * 1000);
      this.scriptCalls += 2;
      keys.slice(1).forEach((k, i) => {
        this.data.set(k, values[i]);
        this.until.set(k, Number(end) * 1000);
        this.scriptCalls += 1;
      });
      return 1;
    }
    this.scriptCalls += 1;
    const read = ["actions", "bytes", "expiresAt"].map((name) => field(hash, name));
    if (read.every((v) => v === undefined)) return [0];
    const [a, b, e] = read.map(digits);
    if (a === null || b === null || e === null || a < 0 || b < 0 || e < 0) return [-1];
    const [now, by, actionsCap, bytesCap] = argv.map(Number);
    if (now >= e) return [-2];
    if (a >= actionsCap) return [-3];
    if (b + by > bytesCap) return [-4];
    hash!.set("actions", String(a + 1));
    hash!.set("bytes", String(b + by));
    this.scriptCalls += 2;
    return [1, a + 1, b + by];
  }

  /** lib/store-assistant.ts, ASSISTANT_POOL: the Store assistant's month, reserved, settled and given back. */
  private assistantPool(args: string[]): unknown {
    if (args[0] !== "1") throw new Error("ERR assistant-pool: arguments");
    const key = args[1];
    const [op, rawHold, third, fourth] = args.slice(2);
    this.live(key);
    const held0 = this.data.get(key);
    if (held0 !== undefined && !(held0 instanceof Map)) return -1;
    const amount = (value: string | undefined) => (value !== undefined && /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 1e12 ? Number(value) : null);
    const hold = amount(rawHold);
    if (hold === null || hold <= 0) return -1;
    const existing = held0 instanceof Map ? held0 : null;
    const held = amount(existing?.get("held") ?? "0"), spent = amount(existing?.get("spent") ?? "0");
    if (held === null || spent === null) return -1;
    if (op === "reserve") {
      let cap = amount(third);
      const ttl = amount(fourth);
      if (cap === null || ttl === null || ttl <= 0) return -1;
      const kept = existing?.get("cap");
      if (kept !== undefined) {
        const was = amount(kept);
        if (was === null) return -1;
        cap = Math.min(cap, was);
      }
      if (held + spent + hold > cap) return 0;
      const hash = this.hash(key);
      hash.set("held", String(held + hold));
      hash.set("cap", String(cap));
      if (!this.until.has(key)) this.until.set(key, this.now() + ttl * 1000);
      return 1;
    }
    if (op === "settle" || op === "release") {
      if (held < hold) return -1;
      let settled = 0;
      if (op === "settle") {
        const value = amount(third);
        if (value === null || value > hold) return -1;
        settled = value;
      }
      const hash = this.hash(key);
      hash.set("held", String(held - hold));
      if (op === "settle") {
        hash.set("spent", String(spent + settled));
        hash.set("n", String((Number(hash.get("n")) || 0) + 1));
      }
      return 1;
    }
    return -1;
  }

  /**
   * Commands the scripts run here step by step sent inside them, which Upstash
   * bills one by one beside the EVAL (https://upstash.com/docs/redis/overall/billing,
   * read 31 October 2026): counted for lib/capped-count.ts, so a test can hold
   * what a request is billed, not only what it sends (tests/traffic.test.ts).
   */
  scriptCalls = 0;

  /** lib/capped-count.ts: counts that never grow a hash past its most fields, the way version 2 runs them. */
  private cappedCount(args: string[]): unknown {
    const n = Number(args[0]);
    const keys = args.slice(1, 1 + n);
    const argv = args.slice(1 + n);
    if (!Number.isInteger(n) || n < 1 || argv.length < n || (argv.length - n) % 3 !== 0 || new Set(keys).size !== keys.length) throw new Error("ERR capped-count: arguments");
    const caps = argv.slice(0, n).map(Number);
    if (caps.some((cap) => !Number.isInteger(cap) || cap < 1)) throw new Error("ERR capped-count: most");
    const rest = argv.slice(n);
    const left = new Map<number, number>();
    for (let i = 0; i < rest.length; i += 3) {
      const k = Number(rest[i]);
      const by = Number(rest[i + 2]);
      if (!Number.isInteger(k) || k < 1 || k > n || !Number.isInteger(by) || rest[i + 1] === "" || rest[i + 1] === "~") throw new Error("ERR capped-count: count");
      left.set(k, (left.get(k) ?? 0) + 1);
    }
    // Each hash's length once (HLEN), and which names are there (one HMGET) only for a hash a new name may not fit in.
    const len = new Map<number, number>();
    const there = new Map<number, Set<string>>();
    for (let k = 1; k <= n; k += 1) {
      if (!left.has(k)) continue;
      this.live(keys[k - 1]);
      const hash = this.hash(keys[k - 1]);
      this.scriptCalls += 1;
      len.set(k, hash.size);
      if (hash.size + left.get(k)! > caps[k - 1]) {
        this.scriptCalls += 1;
        const names = [...rest.filter((_, i) => i % 3 === 1 && Number(rest[i - 1]) === k), "~"];
        there.set(k, new Set(names.filter((name) => hash.has(name))));
      }
    }
    const out: number[] = [];
    for (let i = 0; i < rest.length; i += 3) {
      const k = Number(rest[i]);
      const hash = this.hash(keys[k - 1]);
      const field = rest[i + 1];
      const by = Number(rest[i + 2]);
      const held = there.get(k);
      this.scriptCalls += 1;
      if (!held || held.has(field) || len.get(k)! < caps[k - 1]) {
        if (held && !held.has(field)) {
          held.add(field);
          len.set(k, len.get(k)! + 1);
        }
        const next = (Number(hash.get(field)) || 0) + by;
        hash.set(field, String(next));
        out.push(next);
      } else {
        if (!held.has("~")) {
          held.add("~");
          len.set(k, len.get(k)! + 1);
        }
        hash.set("~", String((Number(hash.get("~")) || 0) + by));
        out.push(0);
      }
    }
    return out;
  }

  private hostClaim(args: string[]): unknown {
    const count = Number(args[0]);
    const keys = args.slice(1, 1 + count);
    const argv = args.slice(1 + count);
    const [now, s, e] = argv.slice(0, 3).map(Number);
    const claim = argv[3];
    const hold = Number(argv[4]);
    const ref = argv[5];
    if (!Number.isFinite(now) || !Number.isFinite(s) || !Number.isFinite(e) || e <= s || !Number.isFinite(hold) || claim === "" || argv.length !== 6 + 4 * keys.length || keys.length === 0) return [-3, 0];
    for (let i = 0; i < keys.length; i += 1) {
      this.live(keys[i]);
      const held = this.data.get(keys[i]);
      if (held !== undefined && !(held instanceof Map)) return [-3, i + 1];
    }
    const drops: string[][] = [];
    for (let i = 0; i < keys.length; i += 1) {
      const [gap, d0, d1, cap] = argv.slice(6 + i * 4, 10 + i * 4).map(Number);
      if (![gap, d0, d1, cap].every(Number.isFinite) || gap < 0) return [-3, i + 1];
      const held = this.data.get(keys[i]);
      const stale: string[] = [];
      let today = 0;
      for (const [field, raw] of held instanceof Map ? held : new Map<string, string>()) {
        const m = /^(\d+)\|(\d+)\|(\d+)\|/.exec(raw);
        if (!m) return [-3, i + 1];
        const [a, b, u] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if ((u > 0 && u < now) || b < now - 172_800_000) stale.push(field);
        else if (field !== claim) {
          if (s < b + gap && e + gap > a) return [-1, i + 1];
          if (a >= d0 && a < d1) today += 1;
        }
      }
      if (today >= cap) return [-2, i + 1];
      drops.push(stale);
    }
    const keep = e - now + 172_800_000;
    keys.forEach((k, i) => {
      const hash = this.hash(k);
      for (const field of drops[i]) hash.delete(field);
      hash.set(claim, `${s}|${e}|${hold}|${ref}`);
      const ends = this.until.get(k);
      const left = ends === undefined ? -1 : ends - this.now();
      if (left < keep) this.until.set(k, this.now() + keep);
    });
    return [1, 0];
  }

  /** The shape lib/redis.ts exports: one reply per command, in order. */
  pipeline = async (commands: (string | number)[][]): Promise<unknown[]> => commands.map((one) => this.run(one));
}
