/**
 * 663 [HF1]: a failure's words tell the truth about the month's count (VR,
 * item 2), and a customer's words sent to the model lose a web address even
 * without "http" or "www" (the privacy policy says any web address is taken
 * out).
 *
 * lib/ai.ts `counted` takes the month's job before the model is asked and
 * keeps a started try counted, because the provider may bill it: "failed"
 * always comes after the job was taken. Checked through the real code, with
 * the model answering an error:
 *
 *   - the outreach pitch (lib/ai.ts writePitch, the only source of the
 *     outreach route's "failed"): "failed", the month's job counter one
 *     higher, and the outreach studio's words for "failed" say the try
 *     counted, never that nothing was;
 *   - the question about the store's numbers (lib/numbers-ask.ts askNumbers):
 *     the same, with the Numbers panel's words for "failed";
 *   - the Numbers panel shows its "server_error" words for any answer that is
 *     not JSON (a request cut at the platform's time limit, a dropped
 *     connection), which can come after the model was asked: those words say
 *     the try may have counted, never that nothing was.
 *
 * And lib/customer-voice.ts cleanVoice, by the same rule as the reviews'
 * summary (lib/review-ai-summary-rules.ts cleanReviewText): "janesmith.dev"
 * and "Coach.Academy/join" become [link]; prices, ratings, times, "e.g." and
 * "Node.js" stay as written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aiMonthKey, writePitch } from "@/lib/ai";
import { askNumbers } from "@/lib/numbers-ask";
import { cleanVoice } from "@/lib/customer-voice";
import type { StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.anthropic.com") {
    modelCalls++;
    return json({ type: "error", error: { type: "overloaded_error" } }, 529);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The text of one entry of a component's words, read from its source as the page draws it. */
function said(file: string, key: string): string {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const found = new RegExp(`\\n\\s*${key}: "([^"]*)"`).exec(source);
  if (!found) throw new Error(`${file} has no ${key} words`);
  return found[1];
}

const window = (visitors: number, checkouts: number, sales: number, cents: number) => ({ visitors, views: visitors * 2, checkouts, sales, cents });
const numbers = {
  currency: "usd",
  sales: "ok",
  totals: { d7: window(120, 9, 3, 8100), d30: window(480, 30, 11, 45000), d90: window(1300, 80, 30, 120000), all: window(2000, 100, 0, 0) },
  previous: { d7: window(90, 6, 2, 5400), d30: window(400, 20, 8, 30000), d90: window(1000, 60, 20, 90000) },
  channels: { d7: [], d30: [{ source: "instagram", visits: 300, checkouts: 18, free: 5, sales: 7, cents: 31500 }], d90: [] },
  products: [],
  posts: { d7: [], d30: [], d90: [] },
  ads: { d7: [], d30: [], d90: [] },
  countries: { d7: [], d30: [], d90: [], all: [] },
  devices: { d7: [], d30: [], d90: [], all: [] },
  renewals: null,
  buyers: { d7: { buyers: 3, orders: 3, cents: 8100, returning: 1, repeat: 0 }, d30: { buyers: 10, orders: 11, cents: 45000, returning: 2, repeat: 1 }, d90: { buyers: 25, orders: 30, cents: 120000, returning: 4, repeat: 2 } },
  searchMisses: { d7: [], d30: [], d90: [] },
  topBuyers: [],
} as unknown as StatsData;

const OWNER = "hf1-counted@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "hfonecounted", "HF One Counted", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HfOneCounted01", subscriptionId: "sub_HfOneCounted01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();
  const key = aiMonthKey(store, new Date(now));
  const jobs = async () => Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0);

  part("The outreach pitch");
  const beforePitch = await jobs();
  const callsBeforePitch = modelCalls;
  const pitch = await writePitch(store, { goal: "sponsor", sender: "Sam", company: "Brand Co", about: "We make running shoes.", sells: ["Trail Plan"], commission: null, notes: "A paid mention in my weekly trail video." }, now);
  is(
    "the model answering an error: failed, after the model was asked, and the month's job still counted",
    [pitch.ok ? "ok" : pitch.reason, modelCalls > callsBeforePitch, (await jobs()) - beforePitch],
    ["failed", true, 1],
  );
  const outreachFailed = said("components/outreach-studio.tsx", "failed");
  is(
    "so the outreach studio's failed words never say nothing was counted, and say the try counted",
    [/nothing was counted/i.test(outreachFailed), /counted as one of this month's writing jobs/i.test(outreachFailed)],
    [false, true],
  );
  // The new pitch is saved after writePitch took the job, and anything thrown there is the route's server_error.
  const outreach = readFileSync(join(process.cwd(), "lib/outreach.ts"), "utf8");
  const route = readFileSync(join(process.cwd(), "app/api/store/outreach/route.ts"), "utf8");
  is(
    "the pitch is saved after the writing job was taken, and a throw there is the route's server_error",
    [outreach.indexOf("await writePitch(") > 0 && outreach.indexOf('["HSET", key(store.statsId, "pitches"), pitch.id') > outreach.indexOf("await writePitch("), /catch \(error\) \{[\s\S]*?fail\("server_error", 500\)/.test(route)],
    [true, true],
  );
  const outreachServer = said("components/outreach-studio.tsx", "server_error");
  is(
    "so the outreach studio's server_error words never say nothing was changed or counted, and say the try may have counted",
    [/nothing was (changed|counted)/i.test(outreachServer), /may have counted as one of this month's writing jobs/i.test(outreachServer)],
    [false, true],
  );

  part("A question about the store's numbers");
  const beforeAsk = await jobs();
  const callsBeforeAsk = modelCalls;
  const asked = await askNumbers(store, "Which channel brought the most money?", numbers, now);
  is(
    "the model answering an error: failed, after the model was asked, and the month's job still counted",
    [asked.ok ? "ok" : asked.reason, modelCalls > callsBeforeAsk, (await jobs()) - beforeAsk],
    ["failed", true, 1],
  );
  const askFailed = said("components/numbers-ask.tsx", "failed");
  is(
    "so the Numbers panel's failed words never say nothing was counted, and say the try counted",
    [/nothing was counted/i.test(askFailed), /counted as one of this month's AI jobs/i.test(askFailed)],
    [false, true],
  );
  const panel = readFileSync(join(process.cwd(), "components/numbers-ask.tsx"), "utf8");
  is(
    "the Numbers panel shows server_error for an answer that is not JSON or a dropped connection",
    [/\?\? MESSAGES\.server_error\)/.test(panel), /catch \{\s*setError\(MESSAGES\.server_error\)/.test(panel)],
    [true, true],
  );
  const askServer = said("components/numbers-ask.tsx", "server_error");
  is(
    "so its server_error words never say nothing was counted, and say the try may have counted",
    [/nothing was counted/i.test(askServer), /may have counted as one of this month's AI jobs/i.test(askServer)],
    [false, true],
  );

  part("A customer's words lose every web address before the model reads them");
  is("an address without http or www is a link", cleanVoice("More tips at janesmith.dev every week"), "More tips at [link] every week");
  is("one with a path is a link too", cleanVoice("Join at Coach.Academy/join today"), "Join at [link] today");
  is("one with http stays a link", cleanVoice("see https://example.com/x"), "see [link]");
  is(
    "prices, ratings, times, abbreviations and a library's name stay as written",
    cleanVoice("Paid $19.99, rated 4.5, came at 9 a.m., e.g. for Node.js"),
    "Paid $19.99, rated 4.5, came at 9 a.m., e.g. for Node.js",
  );
  is("two sentences run together are kept as words", cleanVoice("Loved the course.Wish it had more"), "Loved the course. Wish it had more");
  is("a handle is taken out", cleanVoice("ask @janesmith about it"), "ask [handle] about it");
  is("a short limit still cuts at whole characters", cleanVoice("Great 👍 course for beginners", 7), "Great 👍");
  done();
}

void main();
