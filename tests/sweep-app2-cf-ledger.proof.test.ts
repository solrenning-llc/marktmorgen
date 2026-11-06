/**
 * Sweep APP2 proof (CX-123 rules 24 and 30), synthetic only: app/api/store/import/funnel/route.ts ("save") with
 * lib/clickfunnels-funnel.ts.
 *
 * lib/clickfunnels-funnel.ts:167-171 readLedger answers each field as `Array.isArray(found) && typeof found[i] ===
 * "string" ? found[i] : null`: an HMGET of the run ledger answered in an unknown shape reads as "never made". The
 * ledger is what makes the same import pressed again make nothing twice (build, :232-234: `done`, `partial` and each
 * page's `again`). With one unknown read, a save of an import already done makes its pages, its form and its funnel
 * a second time in the creator's store (and spends another of the month's saves at the route).
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { convertSavedPage, trimSavedPage } from "@/lib/clickfunnels-page";
import { saveFunnelImport } from "@/lib/clickfunnels-funnel";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readForms } from "@/lib/form-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "cf-owner@example.com";

async function counts() {
  const store = (await storeForEmail(OWNER))!;
  return [store.sitePages.length, (await readPageFunnels(store.statsId)).length, (await readForms(store.statsId)).length];
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "cfkitchen", "Moving Kitchen", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const optin = convertSavedPage(trimSavedPage(`<html><head><title>Free plan</title></head><body><h1>Get the free plan</h1><p>Seven days.</p><form><input name="first_name" placeholder="First name"><input type="email" placeholder="Email"><button>Send it</button></form></body></html>`), "optin.html");
  const thanks = convertSavedPage(trimSavedPage(`<html><body><h1>You're in</h1><p>Check your email.</p></body></html>`), "thanks.html");
  const input = {
    name: "Free plan funnel",
    pages: [
      { file: "optin.html", role: "page", product: "", bumps: [], draft: optin },
      { file: "thanks.html", role: "page", product: "", bumps: [], draft: thanks },
    ],
  };

  part("Healthy control: the same import saved again makes nothing twice");
  const first = await saveFunnelImport(store, input);
  if (!first.ok) throw new Error(`not saved: ${first.reason}`);
  is("two pages, one funnel, one form", await counts(), [2, 1, 1]);
  const again = await saveFunnelImport((await storeForEmail(OWNER))!, input);
  is("saved again: answers with what the first made", again.ok ? again.again : again.reason, true);
  is("and nothing is made twice (right)", await counts(), [2, 1, 1]);

  part("DEFECT: the HMGET of the run ledger answered in an unknown shape");
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "HMGET" && String(commands[0][1]).startsWith("nl:imports:cf:")) return [{ 0: "x" }];
    return original(commands);
  }) as typeof redis.pipeline;
  const third = await saveFunnelImport((await storeForEmail(OWNER))!, input);
  redis.pipeline = original;
  is("DEFECT: the save goes through as a new one, not as 'again'", third.ok ? third.again : third.reason, false);
  is("DEFECT: the pages, the funnel and the form are all made a second time", await counts(), [4, 2, 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
