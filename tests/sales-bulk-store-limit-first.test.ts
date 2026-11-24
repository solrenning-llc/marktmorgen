/**
 * Codex X6's LEVE on #3543 (7056589218): once the store's hourly resend counter answers "exceeded" (or cannot be
 * read), no later order in the same bulk request may still spend its own per-sale daily counter, since none of them
 * can be sent. lib/sales-bulk.ts bulkResend. Synthetic store and counters; nothing is sent.
 */
import { bulkResend, type BulkResendDeps } from "@/lib/sales-bulk";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const store = { sid: "s1", handle: "bulkshop" } as unknown as Store;
const ref = (n: number) => `cs_test_${String(n).padStart(12, "0")}`;

async function run(storeAnswer: (call: number) => "within" | "exceeded" | "unknown") {
  const asked: string[] = [];
  const sent: string[] = [];
  let storeCalls = 0;
  const deps: BulkResendDeps = {
    used: async () => 0,
    figure: () => 100,
    limit: async (scope, who) => {
      asked.push(`${scope}:${who}`);
      if (scope === "resend-store") return storeAnswer((storeCalls += 1));
      return "within";
    },
    resend: async (_store, reference) => {
      sent.push(reference);
      return "sent";
    },
  };
  const result = await bulkResend(store, { references: [ref(1), ref(2), ref(3), ref(4)], skipped: 0 }, deps);
  return { asked, sent, result };
}

void (async () => {
  part("The store's hourly counter exhausted: the later orders spend nothing");
  const full = await run((call) => (call >= 2 ? "exceeded" : "within"));
  is("control: the first order is sent", full.sent, [ref(1)]);
  is("the per-sale counter is taken only up to the order the store refused", full.asked, [`resend-sale:${ref(1)}`, "resend-store:s1", `resend-sale:${ref(2)}`, "resend-store:s1"]);
  is("the later orders are said limited, not sent", full.result.ok && full.result.tally.couldNot.map((c) => [c.reference, c.why]), [[ref(2), "limited"], [ref(3), "limited"], [ref(4), "limited"]]);

  part("The store's counter not known: the later orders spend nothing either");
  const blind = await run((call) => (call >= 1 ? "unknown" : "within"));
  is("nothing sent", blind.sent, []);
  is("only the first order's per-sale counter was taken", blind.asked, [`resend-sale:${ref(1)}`, "resend-store:s1"]);
  is("every order 'not confirmed'", blind.result.ok && blind.result.tally.couldNot.map((c) => c.why), ["failed", "failed", "failed", "failed"]);
  done();
})().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
