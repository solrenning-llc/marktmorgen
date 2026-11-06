/**
 * Review proof for #2687: descriptor evidence must be own data.
 *
 * The reader asks for property descriptors so accessors are not executed, but
 * `"value" in descriptor` can still read an inherited Object.prototype value.
 */
import { listHealth } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "b".repeat(32);
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const emptyDay = () => [null, null, null];

async function outcome(reply: unknown): Promise<"accepted" | "unknown"> {
  const original = redis.pipeline;
  try {
    redis.pipeline = async () => reply as unknown[];
    await listHealth(ID, NOW);
    return "accepted";
  } catch {
    return "unknown";
  } finally {
    redis.pipeline = original;
  }
}

async function withInheritedValue<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  Object.defineProperty(Object.prototype, "value", { configurable: true, value });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "value", previous);
    else delete (Object.prototype as { value?: unknown }).value;
  }
}

async function main(): Promise<void> {
  part("Only own data descriptors are Redis evidence");
  is(
    "ordinary complete data remains accepted",
    await outcome([null, ...Array.from({ length: 7 }, emptyDay)]),
    "accepted",
  );

  let outerReads = 0;
  const outer = [null, ...Array.from({ length: 7 }, emptyDay)];
  Object.defineProperty(outer, "0", {
    configurable: true,
    enumerable: true,
    get() {
      outerReads += 1;
      return "not-evidence";
    },
  });
  is(
    "an accessor outer slot cannot borrow inherited null as evidence",
    await withInheritedValue(null, () => outcome(outer)),
    "unknown",
  );
  is("the outer accessor was not executed", outerReads, 0);

  let counterReads = 0;
  const day: unknown[] = ["1000", "25", "1"];
  Object.defineProperty(day, "1", {
    configurable: true,
    enumerable: true,
    get() {
      counterReads += 1;
      return "not-evidence";
    },
  });
  is(
    "an accessor counter cannot borrow inherited zero as confirmed health",
    await withInheritedValue("0", () => outcome([null, day, ...Array.from({ length: 6 }, emptyDay)])),
    "unknown",
  );
  is("the counter accessor was not executed", counterReads, 0);
  done();
}

void main();
