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
  "set-take-count:v1": (run, [set]) => {
    const n = Number(run(["SCARD", set])) || 0;
    run(["DEL", set]);
    return n;
  },
  // lib/community.ts CAS_MEMBER: a member's record written only over what was read, the directory with it.
  "member-cas:v1": (run, [members, dir], [member, was, next, listed, at]) => {
    if (run(["HGET", members, member]) !== was) return 0;
    run(["HSET", members, member, next]);
    run(listed === "1" ? ["ZADD", dir, at, member] : ["ZREM", dir, member]);
    return 1;
  },
  "set-and-values-take:v1": (run, [set, ...plain]) => {
    const members = Number(run(["SCARD", set])) > 0 ? (run(["SMEMBERS", set]) as string[]) : [];
    const values = plain.map((k) => run(["GET", k]) ?? null);
    const gone = (members.length ? 1 : 0) + values.filter((v) => v !== null).length;
    run(["DEL", set, ...plain]);
    return [members, values, gone];
  },
};

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
