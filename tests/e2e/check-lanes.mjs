/**
 * Runs the browser sub-checks of tests/e2e/store-copy.mjs in independent lanes, a few at a time, while the log reads
 * exactly as if they had run one after another in the listed order.
 *
 * A lane is a list of checks that share a fixture or touch the same synthetic state; it always runs in order, alone.
 * Lanes run side by side, at most `limit` at once (each check opens its own browser contexts). Everything a check
 * writes with console.log or console.error is held (AsyncLocalStorage follows it through every await) and printed
 * at that check's place in the listed order, so CI logs keep their order and every "ok"/"FAIL" line.
 *
 * A check that throws is reported at its place and counted as a failure, as the serial script counted it; the
 * rest of its own lane is skipped (its shared state is no longer known) and named, and every other lane still runs
 * and reports, so no failure hides another.
 */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const held = new AsyncLocalStorage();

/**
 * Playwright calls route handlers, event listeners and wait predicates from its own connection, outside the check
 * that registered them, so what they print would lose its check. Each function handed to these methods is bound to
 * the check's context when it is registered; off/removeListener find the bound copy, so a listener still comes off.
 */
const bound = new WeakMap();
const bind = (fn) => {
  if (typeof fn !== "function") return fn;
  if (!bound.has(fn)) bound.set(fn, AsyncResource.bind(fn));
  return bound.get(fn);
};
const ADD = ["on", "once", "addListener", "prependListener", "route", "waitForRequest", "waitForResponse", "waitForEvent"];
const REMOVE = ["off", "removeListener", "unroute"];
function keep(target) {
  for (const method of ADD) {
    const original = target[method]?.bind(target);
    if (original) target[method] = (...args) => original(...args.map(bind));
  }
  for (const method of REMOVE) {
    const original = target[method]?.bind(target);
    if (original) target[method] = (...args) => original(...args.map((arg) => (typeof arg === "function" && bound.has(arg) ? bound.get(arg) : arg)));
  }
}

/** Keeps what a context's and its pages' handlers print with the check that registered them. */
export function keepCheckContext(context) {
  keep(context);
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    const page = await newPage(...args);
    keep(page);
    return page;
  };
  return context;
}
let installed = false;
function holdConsole() {
  if (installed) return;
  installed = true;
  for (const method of ["log", "error"]) {
    const write = console[method].bind(console);
    console[method] = (...args) => {
      const sink = held.getStore();
      if (sink) sink.push([write, args]);
      else write(...args);
    };
  }
}

/**
 * @param {Array<Array<{name:string, run:()=>Promise<void>}>>} lanes checks in their listed order, lane by lane
 * @param {{limit?:number, order:string[], onError:(name:string, error:unknown)=>void, onSkip:(name:string, cause:string)=>void}} options
 *   `order` is every check name in the listed (serial) order; output is printed in that order.
 */
export async function runLanes(lanes, { limit = 3, order, onError, onSkip }) {
  holdConsole();
  const names = lanes.flat().map((check) => check.name);
  if (new Set(names).size !== names.length) throw new Error("Each check needs one unique name");
  if (order.length !== names.length || order.some((name) => !names.includes(name))) throw new Error("The printed order must name every check once");
  const results = new Map();
  let next = 0;
  const flush = () => {
    while (next < order.length && results.has(order[next])) {
      for (const [write, args] of results.get(order[next])) write(...args);
      next += 1;
    }
  };
  const runLane = async (lane) => {
    let broken = null;
    for (const check of lane) {
      const sink = [];
      if (broken) {
        await held.run(sink, async () => onSkip(check.name, broken));
      } else {
        try {
          await held.run(sink, check.run);
        } catch (error) {
          await held.run(sink, async () => onError(check.name, error));
          broken = check.name;
        }
      }
      results.set(check.name, sink);
      flush();
    }
  };
  const queue = [...lanes];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await runLane(queue.shift());
  }));
  flush();
}

/**
 * Reads E2E_SHARD ("k/N"): which of N separate runs of the same script this is. Unset or empty is "1/1", one run
 * that does everything. Anything else that is not k/N with 1 <= k <= N stops the script before a browser opens.
 */
export function parseShard(value) {
  if (value === undefined || value === "") return { index: 1, count: 1 };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`E2E_SHARD must read k/N with 1 <= k <= N, got ${JSON.stringify(value)}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

/**
 * Splits whole lanes between the N runs: `shardOf(lane)` names the run (1..N) that owns a lane, so a lane always runs
 * whole, in its order, in exactly one run, and every lane runs in one of them. `order` is checked against every lane
 * first, as runLanes checks it, then kept only for this run's lanes. With N = 1 every lane is kept.
 * @returns {{lanes: Array<Array<{name:string}>>, order: string[], elsewhere: string[]}}
 */
export function lanesOfShard(lanes, order, { index, count }, shardOf) {
  const names = lanes.flat().map((check) => check.name);
  if (new Set(names).size !== names.length) throw new Error("Each check needs one unique name");
  if (order.length !== names.length || order.some((name) => !names.includes(name))) throw new Error("The printed order must name every check once");
  const kept = [];
  const elsewhere = [];
  for (const lane of lanes) {
    const owner = count === 1 ? 1 : shardOf(lane);
    if (!Number.isInteger(owner) || owner < 1 || owner > count) throw new Error(`Lane ${lane[0]?.name} has no shard in 1..${count}: ${owner}`);
    if (owner === index) kept.push(lane);
    else elsewhere.push(...lane.map((check) => check.name));
  }
  const here = new Set(kept.flat().map((check) => check.name));
  return { lanes: kept, order: order.filter((name) => here.has(name)), elsewhere };
}
