/**
 * The scripts of lib/redis-take.ts (and lib/community.ts's CAS_MEMBER), run by the stand-in Redis the tests use
 * (tests/redis-stub.ts), each as the same plain commands in one step: read
 * and deleted, written or deleted only as read. The record itself is
 * lib/redis-memory-take.ts since 22/11/2026, which lib/redis-memory.ts runs
 * too; this stand-in runs the same record, so the two never part.
 */
import type { MemoryRedis } from "@/lib/redis-memory";
import { TAKE_SCRIPTS } from "@/lib/redis-memory-take";

type Command = (string | number)[];
type Script = (run: (command: Command) => unknown, keys: string[], argv: string[]) => unknown;

const SCRIPTS: Record<string, Script> = TAKE_SCRIPTS;

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
