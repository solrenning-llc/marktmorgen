/**
 * #5285 row #5277: the store's fence on a saved sales filter's write (SAVE_STORE_SECTION in place of SAVE_SECTION) adds
 * the erasing field and the live key to the script, so the whole studio request that saves or renames a filter is
 * measured here through the real route, POST /api/store/sales-filters, against the envelope of one studio unit: 20
 * commands, TAKE_COMMANDS and LOCKED_UNTIL_STAR_COMMANDS (coordinator 964c, the envelope of the other fenced studio
 * writes, as tests/saved-section-route-envelope.test.ts does for #5010 row 126). Every command is billed as Upstash
 * bills it: a plain command is one, and a script is one plus every redis.call written in it (a bound on its worst
 * branch). The request must stay inside the envelope, or this line needs its own price in the registry.
 *
 * Synthetic store and the in-memory Redis; nothing real is called.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/sales-filters/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const ENVELOPE = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
const billed = (command: (string | number)[]): number =>
  command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "filters-envelope@example.test";
  await claimHandle(OWNER, "filtersenvelope", "Filters Envelope", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_envelope", subscriptionId: "sub_envelope", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: `${SESSION_COOKIE}=${await openSession(OWNER)}` };
  const real = redis.pipeline.bind(redis);
  const measured = async (body: Record<string, unknown>) => {
    let commands = 0;
    let fenced = 0;
    redis.pipeline = (async (batch: Commands) => {
      for (const command of batch) {
        commands += billed(command);
        if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:saved-store-section:")) fenced += 1;
      }
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const response = await POST(new NextRequest("https://marktmorgen.com/api/store/sales-filters", { method: "POST", headers, body: JSON.stringify(body) }));
      return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown>, commands, fenced };
    } finally {
      redis.pipeline = real;
    }
  };

  part("A new filter: the whole request");
  const added = await measured({ action: "save", name: "Courses", query: "product=Course&kind=products" });
  is("saved", [added.status, added.data.ok], [200, true]);
  is("through the fenced write", added.fenced, 1);
  is(`its ${added.commands} billed commands stay within one studio unit's ${ENVELOPE}`, added.commands > 0 && added.commands <= ENVELOPE, true);

  part("A rename of that filter: the whole request");
  const id = String((added.data.filter as { id?: unknown } | undefined)?.id ?? "");
  const renamed = await measured({ action: "rename", id, name: "All courses" });
  is("renamed", [renamed.status, renamed.data.ok], [200, true]);
  is("through the fenced write", renamed.fenced, 1);
  is(`its ${renamed.commands} billed commands stay within one studio unit's ${ENVELOPE}`, renamed.commands > 0 && renamed.commands <= ENVELOPE, true);
  console.log(`MEASURED save=${added.commands} rename=${renamed.commands} envelope=${ENVELOPE}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
