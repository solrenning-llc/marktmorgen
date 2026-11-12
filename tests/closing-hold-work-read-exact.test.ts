/**
 * The closing's work hash (lib/closing-holds.ts, workKey) is read exactly
 * (CX-123 rule 24) where it decides what a creator or a member is told.
 *
 * holdCounts took an HKEYS reply that was missing or not a list as no member
 * left unpaused and none past the limit ({ failed: 0, over: 0 }), which
 * readHoldCounts accepts: the creator's closing notice (closingNews,
 * closingLetter) then said "none of your members is charged again" about a
 * hold it could not read. membersOf took an HGETALL reply of the same kind as
 * no member at all: tellBuyers (lib/closing-buyers.ts) then told a member
 * whose payments Stripe refused to pause that "Your membership payments have
 * stopped: nothing more will be charged".
 *
 * Now both throw UnknownReplyError: the notice says it could not check, and
 * the buyers' round sends nothing and is tried again. Synthetic data only,
 * in-memory Redis, Stripe and the email sender stood in for by fetch.
 */
import { startClosingCredit } from "@/lib/closing-credit";
import { tellBuyers } from "@/lib/closing-buyers";
import { holdCounts, membersOf, paidKey, workKey } from "@/lib/closing-holds";
import { closingLetter, closingNews } from "@/lib/plan-closing";
import { claimHandle, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    type One = { to: string | string[]; text?: string };
    const body = JSON.parse(String(init?.body)) as One | One[];
    const all = Array.isArray(body) ? body : [body];
    for (const m of all) sent.push({ to: [m.to].flat()[0], text: String(m.text ?? "") });
    return json(Array.isArray(body) ? { data: all.map((_, i) => ({ id: `email_${sent.length}_${i}` })) } : { id: `email_${sent.length}` });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/payment_intents/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  return json({ error: { message: "not stubbed" } }, 404);
}) as typeof fetch;

const pipe = redis.pipeline.bind(redis);
let workReply: { value: unknown } | "none" | undefined;
redis.pipeline = async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (one && (one[0] === "HKEYS" || one[0] === "HGETALL") && String(one[1]).startsWith("nl:closing:work:") && workReply) return workReply === "none" ? [] : [workReply.value];
  return pipe(commands);
};

const settled = (run: () => Promise<unknown>) => run().then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));

const E = Date.UTC(2026, 10, 1);
const DAY = E + 30 * 86_400_000;
const SUB = "sub_workreadexact";
const MEMBER = "member@buyers.example.com";

async function closingStore(handle: string): Promise<{ store: Store; folder: string }> {
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `Work ${handle}`, "");
  const shop = (await storeForEmail(owner))!;
  const store: Store = { ...shop, stripeAccountId: "acct_1Workreadexact00", planEndedAt: new Date(E).toISOString() };
  const folder = await storeFolder(storeRef(store));
  await startClosingCredit(folder, 100);
  // One member, written down when the plan ended, whose payments Stripe refused to pause (f:).
  await pipe([
    ["HSET", workKey(folder), `m:${SUB}`, MEMBER, `f:${SUB}`, "1", "calls", 50],
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_workreadexact", amt: 1000, tot: 1000, cur: "usd", ps: DAY / 1000 - 15 * 86_400, pe: DAY / 1000 + 15 * 86_400, e: MEMBER })],
  ]);
  return { store, folder };
}

const OFF: [string, { value: unknown } | "none"][] = [
  ["no reply at all", "none"],
  ["undefined", { value: undefined }],
  ["null", { value: null }],
  ["a word", { value: "garbled" }],
  ["an object", { value: {} }],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const realError = console.error;
  console.error = () => {};

  part("control: read as written, one member not paused, and told so");
  {
    const { store, folder } = await closingStore("workcontrol");
    is("holdCounts: one not paused", await holdCounts(folder), { failed: 1, over: 0 });
    is("membersOf: the member, not paused", await membersOf(folder), { emails: [MEMBER], missing: [], unpaused: [MEMBER] });
    const news = await closingNews(store, E, DAY, 0);
    is("the creator's notice never says nobody is charged again", closingLetter("ended", store.name, E, DAY, E).text.length > 0 && closingLetter("ended", store.name, E, DAY, E, news).text.includes("none of your members is charged again"), false);
    sent.length = 0;
    await tellBuyers(store, E, DAY, "", Date.now() + 60_000);
    const mine = sent.filter((m) => m.to === MEMBER);
    is("the member is told once", mine.length, 1);
    is("and told payments could not be paused", mine[0]?.text.includes("We could not pause your membership payments") ?? false, true);
  }

  let n = 0;
  for (const [label, reply] of OFF) {
    n += 1;
    const { store, folder } = await closingStore(`workoff${String.fromCharCode(96 + n)}`);
    part(`the work hash answered ${label}: unknown, never "every member paused"`);
    workReply = reply;
    is(`${label}: holdCounts throws`, await settled(() => holdCounts(folder)), { ok: false, error: "UnknownReplyError" });
    is(`${label}: membersOf throws`, await settled(() => membersOf(folder)), { ok: false, error: "UnknownReplyError" });
    const news = await closingNews(store, E, DAY, 0);
    is(`${label}: the notice carries the hold as not checked`, [news.notHeld, news.overLimit], [null, null]);
    is(`${label}: the creator is never told nobody is charged again`, closingLetter("ended", store.name, E, DAY, E, news).text.includes("none of your members is charged again"), false);
    sent.length = 0;
    const told = await settled(() => tellBuyers(store, E, DAY, "", Date.now() + 60_000));
    is(`${label}: the buyers' round is not done`, told.ok, false);
    is(`${label}: no member is told their payments stopped`, sent.filter((m) => m.text.includes("Your membership payments have stopped")).length, 0);
    workReply = undefined;
  }

  console.error = realError;
  done();
}

void main();
