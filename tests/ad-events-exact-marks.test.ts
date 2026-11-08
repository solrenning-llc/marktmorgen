/**
 * The once-only marks of the purchases sent from the server (lib/ad-events.ts)
 * are read exactly (CX-123 rule 24; the SET NX list of 21h09, ad-events.ts
 * :690, :723, :783, :826, and the EXISTS reads at :711, :768). Only the exact
 * "OK" is this run's mark; nil is another run's; any other reply (missing,
 * QUEUED, a list cut short or too long, a number) is not known, and nothing
 * is sent on it: a platform never gets the same purchase twice on a guess.
 *
 *   - sendServerPurchase, through the real code with a stand-in Stripe and
 *     Meta: a mark answered in any shape other than "OK" or nil sends
 *     nothing and says "unknown"; "OK" sends once; nil is "already";
 *   - the helpers that every mark and EXISTS in the file go through read only
 *     the exact shapes, and no SET of a sent mark is read loosely.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markIsOurs, markSeen, sendServerPurchase, setServerToken } from "@/lib/ad-events";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { NO_PIXELS } from "@/lib/pixels";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_marks_stand_in";

const OWNER = "marks@example.com";
const NOW = Date.now();
const META_TOKEN = "EAAB" + "m".repeat(60);

let sentToMeta = 0;
const session = (id: string) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 4900,
  currency: "usd",
  created: Math.floor(NOW / 1000) - 60,
  customer_details: { email: "buyer@example.com", address: { country: "US" } },
  payment_intent: `pi_${id}`,
  metadata: { store: "marks", product: "prod000001" },
});
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "graph.facebook.com") {
    sentToMeta += 1;
    return json({ events_received: 1 });
  }
  const one = /\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
  if (one) return json(session(one[1]));
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The reply the sent mark's SET gets instead of the real one; undefined for the real one. */
let markReply: unknown = undefined;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const mark = commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:adsrv:sent:");
  if (mark && markReply !== undefined) {
    const real = await pipeline(commands);
    return markReply === "drop" ? real.slice(0, 0) : [markReply, ...real.slice(1)];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "marks", "Marks Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMarks00001", true);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  await setServerToken(statsId, "meta", META_TOKEN);
  await setAdsServer(OWNER, ["meta"]);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  const store = (await storeForEmail(OWNER))!;
  const buyer = { ip: "203.0.113.9", userAgent: "Mozilla/5.0", url: "https://marktmorgen.com/@marks/thanks", cookies: {} };

  part("sendServerPurchase: only an exact OK is this run's mark");
  let n = 0;
  for (const [label, reply] of [
    ["no reply for the mark", "drop"],
    ["QUEUED", "QUEUED"],
    ["OK written as a list", ["OK"]],
    ["a number", 1],
    ["true", true],
  ] as const) {
    markReply = reply;
    n += 1;
    const before = sentToMeta;
    const result = await sendServerPurchase(store, `cs_test_marks${String(n).padStart(9, "0")}`, buyer, NOW);
    is(`${label}: nothing sent, said as unknown`, [result, sentToMeta - before], ["unknown", 0]);
  }
  markReply = undefined;
  const before = sentToMeta;
  is("the exact OK: sent once", [await sendServerPurchase(store, "cs_test_marks000000099", buyer, NOW), sentToMeta - before], ["sent", 1]);
  is("nil: already, nothing more sent", [await sendServerPurchase(store, "cs_test_marks000000099", buyer, NOW), sentToMeta - before], ["already", 1]);

  part("the helpers read only exact shapes");
  is("markIsOurs: only the string OK", [markIsOurs("OK"), markIsOurs(null), markIsOurs(undefined), markIsOurs("QUEUED"), markIsOurs(["OK"]), markIsOurs(1)], [true, false, false, false, false, false]);
  is("markSeen: 1 seen, 0 not seen, anything else unknown", [markSeen(1), markSeen(0), markSeen("1"), markSeen(null), markSeen(undefined), markSeen(2), markSeen(true)], [true, false, null, null, null, null, null]);

  part("no sent mark in the file is read loosely");
  const source = readFileSync(join(process.cwd(), "lib/ad-events.ts"), "utf8");
  is("no SET of a sent mark compared with null", /\["SET", sentKey\([^\n]*\n?[^\n]*=== null/.test(source), false);
  is("no EXISTS of a sent mark read with Number()", /Number\((sent|marks)\[i\]\)/.test(source), false);
  done();
}

void main();
