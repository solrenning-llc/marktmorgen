/**
 * The Redis stand-in (tests/redis-stub.ts) running lib/apply-first-store.ts's
 * two scripts step for step on its own commands, as Redis runs a script: one
 * step, nothing between (lib/redis-memory.ts does not model them). Every
 * command sent is recorded, and a test may answer one in place of the
 * stand-in, to make a reply lost, in another shape, or a race. Synthetic only.
 */
import { store as memory } from "./redis-stub";
import { APPLY_CHANGE, APPLY_NEW } from "@/lib/apply-first-store";

type Cmd = (string | number)[];
const base = memory.run.bind(memory);

export const redis = {
  /** Every command sent through the pipeline, in order. */
  sent: [] as Cmd[],
  /** Answers a command in place of the stand-in, or undefined to let it run. */
  fault: null as ((command: Cmd) => unknown) | null,
  /** The stand-in itself, without recording. */
  run: (command: Cmd) => base(command),
};

/** One of the two scripts, run on the stand-in. */
export function runScript(command: Cmd): unknown {
  const [, script, , ...rest] = command.map(String);
  const inner = redis.run;
  const extend = (indexes: string[], ttl: string) => {
    for (const index of indexes) if (Number(inner(["TTL", index])) < Number(ttl)) inner(["EXPIRE", index, ttl]);
  };
  if (script === APPLY_NEW) {
    const [record, stores, person, id, text, ttl, until, now, most, mostPerson] = rest;
    if (inner(["EXISTS", record]) !== 0) return 3;
    inner(["ZREMRANGEBYSCORE", stores, "-inf", now]);
    inner(["ZREMRANGEBYSCORE", person, "-inf", now]);
    if (Number(inner(["ZCARD", stores])) >= Number(most)) return 4;
    if (Number(inner(["ZCARD", person])) >= Number(mostPerson)) return 5;
    inner(["SET", record, text, "EX", ttl]);
    inner(["ZADD", stores, until, id]);
    inner(["ZADD", person, until, id]);
    extend([stores, person], ttl);
    return 1;
  }
  if (script === APPLY_CHANGE) {
    const [record, stores, person, old, text, ttl, until, id] = rest;
    if (inner(["GET", record]) !== old) return 0;
    inner(["SET", record, text, "EX", ttl]);
    inner(["ZADD", stores, until, id]);
    inner(["ZADD", person, until, id]);
    extend([stores, person], ttl);
    return 1;
  }
  return base(command);
}

memory.run = (command: Cmd) => {
  redis.sent.push(command);
  if (redis.fault) {
    const answer = redis.fault(command);
    if (answer !== undefined) return answer;
  }
  return String(command[0]).toUpperCase() === "EVAL" ? runScript(command) : base(command);
};

/** The commands a list of sent ones ran, each script counted with the commands it runs. */
export function commandsRun(sent: Cmd[]): number {
  const steps = (script: string) => script.split("redis.call(").length - 1;
  return sent.reduce((n, c) => n + 1 + (String(c[1]) === APPLY_NEW ? steps(APPLY_NEW) : String(c[1]) === APPLY_CHANGE ? steps(APPLY_CHANGE) : 0), 0);
}

export { memory };
