/**
 * Focused regressions for three store paths of the unknown short-window count (#3067, Codex X6's LOW at f5aaecb934:
 * "focused regressions are still missing for the embed/affiliate/download unknown-limit branches"). An unreadable
 * count (withinLimit, lib/request-guard.ts) is never "past the limit" and never room (rule 24): each path says it
 * could not check just now, while a confirmed count past the limit answers exactly as before.
 *
 *   - app/api/store/affiliates/join: "error" (the page's "try again"), never "limited";
 *   - lib/embed-open.ts readScriptOpen: the plain link with reason "unknown", never "limited".
 *
 * The download route's branch (withinStoreWhy(…).catch(unknownLimit)) needs a signed, paid download link; it is
 * read here from the source, as the other bare checks are, until a fixture for that link exists.
 *
 * Synthetic data only: the counter's reply is replaced for one scope at a time; Redis, Stripe and email stand-ins.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { readScriptOpen } from "@/lib/embed-open";
import { paidPeriod } from "./billing-period-fixture";
import { answering as answeringRequest } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The scope whose counter answers `reply`. */
let target = "";
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const key = String(commands[0]?.[1] ?? "");
  if (target && commands[0]?.[0] === "INCR" && key.startsWith(`nl:rl:${target}:`) && reply !== null) return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

const UNREADABLE = ["1", 1];
const OVER = [9_999, 0];

function answering(scope: string, value: unknown): void {
  target = scope;
  reply = value;
}

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const join = () =>
  joinRoute(
    new NextRequest("https://marktmorgen.com/api/store/affiliates/join", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: new URLSearchParams({ handle: "harbor", order: "cs_test_limitunknown01" }).toString(),
    }),
  );

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await ensureStoreId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Harbor000001", subscriptionId: "sub_Harbor000001", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  const store = (await storeForEmail("owner@example.com"))!;

  part("A buyer joining the affiliate program: an unknown count is \"error\", never \"limited\"");
  answering("aff-join", UNREADABLE);
  is("unknown: the page's \"try again\"", (await join()).headers.get("location"), "https://marktmorgen.com/@harbor/affiliates?status=error");
  answering("aff-join", OVER);
  is("past the limit: still \"limited\"", (await join()).headers.get("location"), "https://marktmorgen.com/@harbor/affiliates?status=limited");

  part("The checkout script's open: an unknown count shows the plain link as unknown, never as limited");
  answeringRequest(new NextRequest("https://marktmorgen.com/embed/harbor/p1?mm=page", { headers: { host: "marktmorgen.com", "x-forwarded-for": "203.0.113.9" } }));
  answering("embed-open", UNREADABLE);
  let open = await readScriptOpen(store, "page", {});
  is("unknown: the plain link, said as unknown", [open.live, open.reason], [false, "unknown"]);
  answering("embed-open", OVER);
  open = await readScriptOpen(store, "page", {});
  is("past the limit: still \"limited\"", [open.live, open.reason], [false, "limited"]);
  answeringRequest(null);

  part("The download link's count: unknown says the check failed, never \"opened very many times\"");
  const download = readFileSync("app/api/store/download/route.ts", "utf8");
  is("the short window's unknown count is read as \"unknown\"", /withinStoreWhy\("download",[^\n]*\)\.catch\(unknownLimit\)/.test(download), true);
  is("and answered with the purchase check's failure", /if \(counted === "unknown"\) \{\s*return new Response\(say\.purchaseCheckFailed/.test(download), true);
  done();
}

void main();
