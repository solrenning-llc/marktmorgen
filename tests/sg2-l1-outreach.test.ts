/**
 * Outreach's stop list and day counter read only in their exact shape
 * (audit SG2, CX-123 rule 24).
 *
 * startPitch (lib/outreach.ts) asked Redis whether the business had asked to
 * stop (SISMEMBER, on the store's list and on everyone's) and how many
 * pitches the store wrote today (GET), and read the answers with Number():
 * a malformed reply was "not stopped" and "0 written today", so a pitch
 * could be written to a business that opted out, or past the day's number.
 * Now a stop is "no" only when Redis answers exactly 0, the day's count is a
 * whole number or no key at all (none written yet), and anything else
 * refuses the pitch as "unavailable", before the model is asked.
 *
 * readStopLink, behind the page a business opens from a pitch's footer,
 * says a stop holds only when Redis answers exactly 1; anything else keeps
 * the stop buttons on the page, so the way out is never hidden.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, readStopLink, saveSender, startPitch } from "@/lib/outreach";
import { PITCHES_PER_DAY } from "@/lib/outreach-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  modelCalls += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: '{"subject": "A recipe video", "body": "Hi,\\n\\nWould a recipe video be of interest?"}' }] }), { status: 200 });
}) as typeof fetch;

/** The replies the stop-and-day check gets instead of the real ones; "throw" for a Redis that cannot be asked. */
let checkReply: unknown = undefined;
/** The replies the stop page's check gets instead of the real ones. */
let pageReply: unknown = undefined;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const check = commands.length === 3 && commands[0]?.[0] === "SISMEMBER" && commands[1]?.[0] === "GET" && commands[2]?.[0] === "SISMEMBER";
  const page = commands.length === 2 && commands[0]?.[0] === "SISMEMBER" && commands[1]?.[0] === "SISMEMBER";
  const reply = check ? checkReply : page ? pageReply : undefined;
  if (reply === "throw") throw new Error("the database did not answer");
  if (reply !== undefined) return reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

const PAGE = "https://copperoak.com/partners";
const SITE: Record<string, string> = {
  "https://copperoak.com/robots.txt": "User-agent: *\nDisallow: /cart\n",
  [PAGE]: "<html><body><p>Creators and sponsors: write to partnerships@copperoak.com.</p></body></html>",
};
const reader: PageReader = async (url) => (url in SITE ? { url, html: SITE[url] } : null);

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }) });
  const store = (await storeForEmail("owner@example.com"))!;
  await saveSender(store, { name: "Jenny Park", address: "PO Box 12, Columbus, OH 43004, USA" });
  const NOW = Math.floor(Date.now() / 1000) - 86_400;
  const input = { goal: "sponsor" as const, country: "US", isCompany: false, page: PAGE, email: "partnerships@copperoak.com", company: "Copper & Oak", about: "Pans.", notes: "I post three family recipes a week." };
  const attempt = async (reply: unknown) => {
    checkReply = reply;
    const before = modelCalls;
    const result = await startPitch(store, input, { reader, now: NOW }).catch(() => ({ ok: false as const, reason: "threw" }));
    return { outcome: result.ok ? "written" : result.reason, asked: modelCalls > before };
  };

  part("startPitch: a business is written to only on an exact 'not stopped' and a known day's count");
  const MALFORMED: [string, unknown][] = [
    ["the store's stop answered null", [null, null, 0]],
    ["the store's stop as text", ["0", null, 0]],
    ["the store's stop as false", [false, null, 0]],
    ["the store's stop as 2", [2, null, 0]],
    ["everyone's stop answered null", [0, null, null]],
    ["everyone's stop as an object", [0, null, { n: 0 }]],
    ["the day's count not a number", [0, "many", 0]],
    ["the day's count negative", [0, "-3", 0]],
    ["the day's count a fraction", [0, "1.5", 0]],
    ["the day's count true", [0, true, 0]],
    ["the day's count an object", [0, { n: 1 }, 0]],
    ["one reply missing", [0, null]],
    ["one reply too many", [0, null, 0, 0]],
    ["an empty reply", []],
    ["a reply that is not a list", { result: [0, null, 0] }],
  ];
  for (const [label, reply] of MALFORMED) {
    const got = await attempt(reply);
    is(`${label}: refused as unavailable`, got.outcome, "unavailable");
    is(`${label}: and the model is never asked`, got.asked, false);
  }
  is("the store's stop answered 1: stopped", (await attempt([1, null, 0])).outcome, "stopped");
  is("everyone's stop answered 1: stopped", (await attempt([0, null, 1])).outcome, "stopped");
  is("the day's number reached: refused for the day", (await attempt([0, String(PITCHES_PER_DAY), 0])).outcome, "day");
  const fine = await attempt([0, String(PITCHES_PER_DAY - 1), 0]);
  is("exact answers below the day's number: written, as before", [fine.outcome, fine.asked], ["written", true]);

  part("readStopLink: a stop is said to hold only on an exact 1");
  checkReply = undefined;
  const written = await startPitch(store, { ...input, page: "https://oakfield.com/contact", email: "hello@oakfield.com", company: "Oakfield" }, { reader: async (url) => (url === "https://oakfield.com/contact" ? { url, html: "<p>hello@oakfield.com</p>" } : null), now: NOW + 3 * 86_400 });
  if (!written.ok) throw new Error(`not written: ${written.reason}`);
  const token = written.pitch.stop;
  const shown = async (reply: unknown) => {
    pageReply = reply;
    const found = await readStopLink(token).catch(() => "threw" as const);
    return found === "threw" || !found ? found : [found.stopped, found.everyone];
  };
  is("exact: not stopped anywhere", await shown([0, 0]), [false, false]);
  is("exact: stopped by this store", await shown([1, 0]), [true, false]);
  is("exact: stopped everywhere", await shown([0, 1]), [true, true]);
  is("the store's stop as text '1': not claimed, the buttons stay", await shown(["1", 0]), [false, false]);
  is("everyone's stop as text '1': not claimed, the buttons stay", await shown([0, "1"]), [false, false]);
  is("everyone's stop as true: not claimed", await shown([0, true]), [false, false]);
  is("a reply missing one answer: not claimed", await shown([1]), [false, false]);
  is("a reply that is not a list: not claimed", await shown({ result: [1, 1] }), [false, false]);
  pageReply = undefined;

  done();
}

void main();
