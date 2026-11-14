/**
 * Claude 5's MEDIUM 2 on #2794 (6701761695, still open per 6800433438): importedFrom returns the legible rows
 * when one row is illegible. That is right for granting access, but a person's data copy must be complete and
 * the next-offer "already owned" read must show nothing on an unknown read. Synthetic: MemoryRedis, no network.
 */
import { COPIERS } from "@/lib/person-copy";
import { importedKey } from "@/lib/imported-purchases";
import { ownedHere } from "@/lib/next-offer";
import type { Store } from "@/lib/store";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_complete_read_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error("no other provider in this test");
}) as typeof fetch;

const EMAIL = "person@example.com";
const grant = (job: string, extra: Record<string, unknown> = {}) => JSON.stringify({ at: 1_793_293_200, job, items: null, ...extra });
const copier = COPIERS["lib/imported-purchases.ts"];
const scope = (statsId: string) => ({ statsId, email: EMAIL }) as unknown as ErasureScope;
const shop = (statsId: string) => ({ statsId, handle: "completeread", previousHandles: [], releasedHandles: [], currency: "usd", pastBuyers: true, stripeAccountId: "acct_completeread01" }) as unknown as Store;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try { return await run(); } catch { return "refused"; }
}

async function main() {
  part("controls: exact rows are read in full");
  redis.clear();
  const good = "e".repeat(32);
  await redis.pipeline([["HSET", importedKey(good, EMAIL), "course_1", grant("import_job_1"), "course_2", grant("import_job_2")]]);
  is("the copy lists both exact grants", ((await copier(scope(good))) as unknown[]).length, 2);
  is("next-offer sees both as owned", [...((await ownedHere(shop(good), EMAIL)) ?? [])].sort(), ["course_1", "course_2"]);

  part("one illegible row beside a legible one is not a complete read");
  redis.clear();
  const mixed = "f".repeat(32);
  await redis.pipeline([["HSET", importedKey(mixed, EMAIL), "course_1", grant("import_job_1"), "course_2", grant("import_job_2", { option: "not a valid option" })]]);
  is("the person's copy refuses instead of silently leaving a grant out", await outcome(async () => ((await copier(scope(mixed))) as unknown[]).length), "refused");
  is("next-offer shows nothing instead of treating course_2 as not owned", await ownedHere(shop(mixed), EMAIL), null);
  done();
}
main();
