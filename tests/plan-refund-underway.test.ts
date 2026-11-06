/**
 * A refund review must not turn an incomplete or unusual Redis pipeline
 * answer into "settled". The page and route deliberately catch an unknown
 * answer as underway, so another refund cannot be confirmed while evidence
 * is missing.
 */
import { done, is, part } from "./check";
import { store } from "./redis-stub";
import { refundUnderway } from "@/lib/plan-refund-underway";

const originalPipeline = store.pipeline.bind(store);

async function observed(reply: unknown): Promise<boolean | "unknown"> {
  store.pipeline = async () => reply as unknown[];
  try {
    return await refundUnderway("synthetic-refund-store");
  } catch {
    return "unknown";
  } finally {
    store.pipeline = originalPipeline;
  }
}

async function main() {
  part("Only the exact two Redis counters decide refund settlement");
  is("neither note nor lock means settled", await observed([0, 0]), false);
  is("a note means underway", await observed([1, 0]), true);
  is("a running lock means underway", await observed([0, 1]), true);

  part("Incomplete, extra, or coercible answers remain unknown");
  is("no pipeline replies", await observed([]), "unknown");
  is("only the note reply", await observed([0]), "unknown");
  is("an extra reply", await observed([0, 0, 0]), "unknown");
  is("null counters", await observed([null, null]), "unknown");
  is("boolean counters", await observed([false, false]), "unknown");
  is("numeric strings", await observed(["0", "0"]), "unknown");
  is("a coercible positive string", await observed(["1", 0]), "unknown");
  is("a coercible nested number", await observed([[1], 0]), "unknown");

  part("The two slots must be plain owned values");
  let inheritedReads = 0;
  const inherited: unknown[] = [];
  inherited.length = 2;
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, {
    0: { get: () => { inheritedReads += 1; return 0; } },
    1: { get: () => { inheritedReads += 1; return 0; } },
  }));
  is("inherited slots are unknown without observing them", [await observed(inherited), inheritedReads], ["unknown", 0]);

  let getterReads = 0;
  const accessor: unknown[] = [0, 0];
  Object.defineProperty(accessor, 0, { configurable: true, enumerable: true, get: () => { getterReads += 1; return 0; } });
  is("an accessor slot is unknown without invoking it", [await observed(accessor), getterReads], ["unknown", 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
