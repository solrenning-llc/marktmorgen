/**
 * Second pre-review of claude5/affiliate-cap-writes (d3061e755). Synthetic only: the in-memory Redis double, the real
 * routes app/api/store/affiliates/route.ts and app/api/store/affiliates/open/route.ts, and the studio's source.
 *
 * MEDIUM: an undo with no studio requests left said it had undone: undoMany answered 0, undoRates dropped who was left
 * out, the route said ok and the studio "Put back as they were." and took the Undo button away. Now: nothing taken,
 * 429 studio_used, the undo kept on the screen; put back in part, only what came back is said, and the undo is kept.
 * LIGHT 1: an answer refused with 429 in the studio keeps the offer listed ("nothing changed, try later").
 * LIGHT 2: the link page's "resting" words hold for every reason the requests were not taken (the month's figure, the
 *   connection's share of the day, a free store's place, a count not made), never only "used this month".
 * LIGHT 3: the public give-back gives back no more than was taken.
 * LIGHT 4: a read that moved more than was taken for it (records added between its count and its read) is counted at
 *   what it really read, past the figure if it must (forceAllowance), never refused after the read.
 * LIGHT 5: a public hold that is refused is not left counted against the store's window.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAffiliate } from "@/lib/affiliates";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { POST as openRoute } from "@/app/api/store/affiliates/open/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Runs once, just before the program's people are read whole: what happened meanwhile. */
let beforeRead: (() => Promise<void>) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (beforeRead && one?.[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(one[1]))) {
    const run = beforeRead;
    beforeRead = null;
    await run();
  }
  return real(commands);
}) as typeof redis.pipeline;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "cooper@example.com";
  await claimHandle(owner, "coopershop", "Cooper store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1coopersho74fa", true);
  await setSubscription(owner, { customerId: "cus_cooper", subscriptionId: "sub_cooper", active: true, tier: "creator", period: paidPeriod() });
  const p = await addProduct(owner, "Barrel Course", "", "40");
  const P = p.ok ? p.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const statsId = (await store()).statsId as string;
  const people = `nl:aff:${statsId}:people`;
  const id = (n: number) => n.toString(16).padStart(12, "0");
  const person = (n: number, status: string, rate: number | null, share: { percent: number; products: string[] } | null = null, note = "") =>
    JSON.stringify({ id: id(n), email: `person${n}@example.com`, code: `c${n}`, status, appliedAt: n, decidedAt: n, note, rate, paypal: "", share, cleared: null, by: null });
  await real([
    ["HSET", people, id(1), person(1, "approved", null, { percent: 50, products: [P] })],
    ["HSET", people, id(2), person(2, "approved", null)],
    ["HSET", people, id(3), person(3, "approved", 40)],
    ["HSET", people, id(4), person(4, "pending", null)],
  ]);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; undone?: number; left?: number; before?: unknown[] } };
  };
  const figure = async () => allowanceFor(await store(), "studio");
  const used = async () => allowanceUsed(await store(), "studio");
  /** Leaves `n` studio requests of the month. */
  const leave = async (n: number) => {
    const rest = (await figure()) - (await used()) - n;
    if (rest > 0) await takeAllowance(await store(), "studio", rest);
  };
  /** The month's studio requests counted afresh. */
  const reset = async () => {
    const keys = ((await real([["SCAN", 0, "MATCH", "nl:allow:studio:*", "COUNT", 1000]]))[0] as [string, string[]])[1];
    if (keys.length) await real([["DEL", ...keys]]);
  };
  const rateOf = async (n: number) => (await readAffiliate(await store(), id(n)))?.rate;

  part("MEDIUM. An undo with no studio requests left");
  const approved = await post({ action: "bulk", decision: "approve", ids: [id(4)] });
  is("(4 approved)", approved.body.ok, true);
  const raised = await post({ action: "bulk-rate", ids: [id(2)], rate: 30 });
  is("(2 at 30%)", [raised.body.ok, await rateOf(2)], [true, 30]);
  // One request left each time: the press's own passes, what the undo reads and writes does not.
  await leave(1);
  const undoDecision = await post({ action: "bulk-undo", decision: "approve", before: approved.body.before });
  await reset();
  await leave(1);
  const undoRates = await post({ action: "bulk-rate-undo", before: raised.body.before, rate: 30 });
  is("the decisions' undo: 429, nothing put back", [undoDecision.status, undoDecision.body.error, (await readAffiliate(await store(), id(4)))?.status], [429, "studio_used", "approved"]);
  is("the shares' undo: 429, nothing put back", [undoRates.status, undoRates.body.error, await rateOf(2)], [429, "studio_used", 30]);

  part("MEDIUM. Put back in part: only what came back is said");
  await reset();
  is("(requests back for the month)", (await used()) < (await figure()), true);
  // 2 goes back to the program's 5% (lower); 3 goes back to 40% (50 + 40 = 90 + ... over the cap once 3 is at 30).
  await real([["HSET", people, id(3), person(3, "approved", 30)]]);
  await real([["HSET", people, id(1), person(1, "approved", null, { percent: 55, products: [P] })]]);
  const partial = await post({ action: "bulk-rate-undo", before: [{ id: id(2), rate: null }, { id: id(3), rate: 40 }], rate: 30 });
  is("one put back, one left out and counted", [partial.status, partial.body.undone, partial.body.left, await rateOf(2), await rateOf(3)], [200, 1, 1, null, 30]);

  part("The studio says only what came back, and keeps the undo");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("no fixed 'put back' line for either undo", /"Put back as they were\."|"Shares put back as they were\."/.test(studio), false);
  is("the undo kept on a refusal or a part left out", studio.includes("undoWords(") && studio.includes("keepUndo"), true);

  part("LIGHT 1. An answer refused with 429 keeps the offer listed");
  const answer = studio.slice(studio.indexOf('action: "answer"'), studio.indexOf("setGone((prev) => [...prev, id]);"));
  is("429 is 'nothing changed, try later', not 'gone'", /response\.status === 429/.test(answer), true);

  part("LIGHT 2. The link page's words hold for every reason");
  const en = AFFILIATES_WORDS.en.notices.resting;
  is("no claim that the month's requests are used", /used the requests|this month/i.test(en.body), false);
  is("in plain words", en, { title: "This store can't take this right now", body: "Accepting checks the store's partners first, and the store can't take that many requests right now. Nothing was changed. Try again later, or write to the store." });

  part("LIGHT 3. The public give-back gives back no more than was taken");
  const open = readFileSync("app/api/store/affiliates/open/route.ts", "utf8");
  is("bounded by what was taken", /n <= units/.test(open), true);

  part("LIGHT 4. A read that moved more than was taken for it is counted past the figure, never refused");
  await real([["HSET", people, id(3), person(3, "approved", null)], ["HSET", people, id(1), person(1, "approved", null, { percent: 50, products: [P] })]]);
  for (let n = 10; n < 14; n += 1) await real([["HDEL", people, id(n)]]);
  // Only a few records when counted; 2,000 wide ones (some 2.8 MB) by the time they are read, and the month's figure reached meanwhile.
  const wide = "\u0001".repeat(200);
  beforeRead = async () => {
    const writes: (string | number)[][] = [];
    for (let n = 100; n < 2100; n += 1) writes.push(["HSET", people, id(n), person(n, "removed", null, null, wide)]);
    await real(writes);
    const rest = (await figure()) - (await used());
    if (rest > 0) await takeAllowance(await store(), "studio", rest);
  };
  const before = await used();
  const forced = await post({ action: "rate", id: id(2), rate: 20 });
  beforeRead = null;
  is("saved", [forced.status, forced.body.ok], [200, true]);
  is("what was really read is counted, past the figure", (await used()) > (await figure()) && (await used()) > before, true);

  part("LIGHT 5. A public hold that is refused is not left counted");
  const now = await store();
  const limit = publicVisitLimit(requestLimitFor(now));
  const keyOf = async () => ((await real([["SCAN", 0, "MATCH", "nl:traffic:r:*", "COUNT", 1000]]))[0] as [string, string[]])[1][0];
  await takePublicRequest(now, "public", Date.now(), 1, { shared: true });
  const counted = Number((await real([["GET", await keyOf()]]))[0]) || 0;
  await takePublicRequest(now, "public", Date.now(), Math.max(1, limit - counted - 3), { shared: true });
  const atStart = Number((await real([["GET", await keyOf()]]))[0]);
  const token = "e".repeat(64);
  await real([["SET", linkKey(token), JSON.stringify({ s: statsId, e: "late@example.com", n: "", k: 1, p: { percent: 5, products: [P] } }), "EX", 600]]);
  const refused = await openRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/open", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `handle=coopershop&token=${token}` }));
  const atEnd = Number((await real([["GET", await keyOf()]]))[0]);
  is("refused, the page says so", (refused.headers.get("location") ?? "").includes("status=resting"), true);
  is("only the route's own request counted, not the refused hold", atEnd - atStart, 1);
  done();
}
main();
