import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

// Executes only the reviewed test harness's callback and E2E helper. This is
// an instrumented protocol proof, not a React lifecycle or browser-focus run.
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("An exact snapshot directory is required");
const harnessSource = readFileSync(join(sourceRoot, "tests/e2e/deals-board-harness.tsx"), "utf8");
const helperSource = readFileSync(join(sourceRoot, "tests/e2e/deals-board-focus.mjs"), "utf8");
const start = harnessSource.indexOf("useLayoutEffect(() => {");
const end = harnessSource.indexOf("}, [epoch]);", start);
const helperStart = helperSource.indexOf("const mount = async (w) => {");
const helperEnd = helperSource.indexOf("\n  };", helperStart);
if (start < 0 || end <= start || helperStart < 0 || helperEnd <= helperStart) {
  throw new Error("HARNESS: exact reviewed callback/helper could not be located");
}
const callback = harnessSource.slice(start + "useLayoutEffect(".length, end + 1);
const helper = helperSource.slice(helperStart + "const mount = ".length, helperEnd + 4);
let checks = 0;
let failures = 0;
function is(name: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log("ok", name);
  else {
    failures += 1;
    console.log("FAIL", name, JSON.stringify({ actual, expected }));
  }
}

type Gate = { predicate: (epoch: number) => boolean; epoch: number; resolve: () => void };
const loads: number[] = [];
const events: string[] = [];
const gates: Gate[] = [];
let mounted = 4;
let receivedWorld: unknown;
let mountCalls = 0;
let titleCalls = 0;
let networkAttempts = 0;
let timerAllocations = 0;
let setLoadingCalls = 0;
const world = Object.freeze({ synthetic: "next-world" });
const owner = {
  refresh: () => { loads.push(4); },
  mount: (value: unknown) => {
    receivedWorld = value;
    mountCalls += 1;
    events.push("mount");
    return 5;
  },
  get mountedEpoch() { return mounted; },
  set mountedEpoch(value: number) {
    mounted = value;
    // Observe refresh ownership at the exact readiness assignment, before any
    // hypothetical passive effect. This deliberately instruments a test port.
    events.push("ready");
    owner.refresh();
  },
};
const pagePort = {
  async evaluate(fn: (value: unknown) => number, value: unknown) { return fn(value); },
  waitForFunction(predicate: (epoch: number) => boolean, epoch: number) {
    events.push("gate");
    if (predicate(epoch)) return Promise.resolve();
    return new Promise<void>((resolve) => gates.push({ predicate, epoch, resolve }));
  },
  locator(selector: string) {
    if (selector !== "#deals-title") throw new Error("Unexpected locator");
    return { async waitFor() { titleCalls += 1; events.push("title"); } };
  },
};
const network = () => { networkAttempts += 1; throw new Error("Network is forbidden"); };
const timeoutPort = (_fn: () => void, _delay: number) => {
  if (timerAllocations >= 4) throw new Error("Timer-allocation cap before dispatch");
  timerAllocations += 1;
  return timerAllocations;
};
const mount = new Script("(" + helper + ")").runInNewContext({
  page: pagePort,
  window: { harness: owner },
  fetch: network,
  Promise,
}, { timeout: 1000 }) as (value: unknown) => Promise<void>;
const layout = new Script("(" + callback + ")").runInNewContext({
  page: { harness: owner },
  epoch: 5,
  setLoading: (_promise: Promise<void>) => { setLoadingCalls += 1; loads.push(5); },
  setTimeout: timeoutPort,
  fetch: network,
  Promise,
}, { timeout: 1000 }) as () => void;

async function run() {
  let returned = false;
  const waiting = mount(world).then(() => { returned = true; });
  // Bounded microtask admission observes the helper reaching its actual gate;
  // there is no timer, fixed wall-clock sleep, browser, or product module.
  for (let step = 0; step < 8 && gates.length === 0; step += 1) await Promise.resolve();
  if (gates.length !== 1) throw new Error("HARNESS: helper never reached its epoch gate");
  is("the actual helper forwards the exact world once", [receivedWorld === world, mountCalls], [true, 1]);
  is("the gate receives the epoch returned by mount", gates[0].epoch, 5);
  is("the stale title has not released the actual helper before commit", [returned, titleCalls, mounted], [false, 0, 4]);
  is("the old epoch cannot satisfy the actual predicate", gates[0].predicate(5), false);
  layout();
  is("readiness already belongs to this board's refresh", loads, [5]);
  if (!gates[0].predicate(gates[0].epoch)) throw new Error("HARNESS: layout did not publish the requested epoch");
  gates[0].resolve();
  await waiting;
  is("the actual helper uses the title gate only after readiness", [returned, titleCalls, events], [true, 1, ["mount", "gate", "ready", "title"]]);
  owner.refresh();
  is("the next refresh still calls this board's loading setter", [loads, setLoadingCalls], [[5, 5], 2]);
  is("the protocol used no network and bounded synthetic timer ports", [networkAttempts, timerAllocations <= 4], [0, true]);
  console.log(JSON.stringify({ checks, failures, networkAttempts, timerAllocations, scope: "instrumented test-harness callback and helper; no React commit or DOM" }));
  process.exitCode = failures ? 1 : 0;
}
void run().catch((error: unknown) => {
  console.error("HARNESS", String(error));
  process.exitCode = 2;
});
