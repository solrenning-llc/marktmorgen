/**
 * What the database calls made inside `metered` did: how many commands were
 * sent, in how many trips, and how many bytes came back (as the REST API
 * answers them, JSON). An MCP tool of the creator's own records is set aside
 * at its most before it reads, and settled at this before it sends
 * (app/api/mcp/route.ts, `paid`; Codex G2 on #1933). lib/redis.ts and the
 * tests' stand-in note every pipeline they send (noteRead).
 *
 * Like lib/fetch-timeout.ts, it names no Node module: the server's
 * AsyncLocalStorage is found when it runs, and outside one nothing is noted.
 */
export type ReadMeter = { commands: number; trips: number; bytes: number };

type MeterStore = { getStore(): ReadMeter | undefined; run<R>(store: ReadMeter, fn: () => R): R };
const meters: MeterStore | null = (() => {
  const g = globalThis as { AsyncLocalStorage?: new () => MeterStore };
  if (typeof g.AsyncLocalStorage === "function") return new g.AsyncLocalStorage();
  const node = typeof process === "undefined" ? undefined : (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const hooks = node?.("node:async_hooks") as { AsyncLocalStorage?: new () => MeterStore } | undefined;
  return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
})();

/** Runs `work`, counting what the database calls inside it did. Without a place to keep the count, it cannot run. */
export async function metered<T>(work: () => Promise<T>): Promise<{ value: T; meter: ReadMeter }> {
  if (!meters) throw new Error("reads cannot be metered here");
  const meter: ReadMeter = { commands: 0, trips: 0, bytes: 0 };
  const value = await meters.run(meter, work);
  return { value, meter };
}

/** Notes one pipeline sent inside `metered`: its commands, one trip, and the bytes of what it answered. */
export function noteRead(commands: number, answer: unknown): void {
  const meter = meters?.getStore();
  if (!meter) return;
  meter.commands += commands;
  meter.trips += 1;
  try {
    meter.bytes += Buffer.byteLength(JSON.stringify(answer ?? null));
  } catch {
    meter.bytes = Number.POSITIVE_INFINITY;
  }
}
