/**
 * Accepting a partnership reads the inviting program's people to check the 90% cap, and pays for that read before it
 * is made (coordinator, 2026-11-07, rule 30). Synthetic only: the in-memory Redis double, through the real routes
 * app/api/store/affiliates/open/route.ts (the emailed link) and app/api/store/affiliates/route.ts (the answer in the
 * invited creator's studio), in a program of 1,000 records.
 *
 * Before: either way, the whole program (HGETALL, up to ~45 MB) was read with no request counted for it.
 *
 * Now: the people are counted (HLEN), the read is taken at its worst before it (lib/affiliates.ts bulkUnits) from
 * whoever pays for that path (the store's public requests for the emailed link, as its other public links; the
 * answering creator's studio requests in their studio), and once read what it did not need is given back. With too
 * few left, nothing is read or written: the link's page says so in plain words, the studio answers 429, and the link
 * or the offer is kept.
 */
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_NOTE_LENGTH, affiliateByEmail, bulkUnits } from "@/lib/affiliates";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { offerPartnership, waitingOne } from "@/lib/partner-invites";
import { takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { POST as openRoute } from "@/app/api/store/affiliates/open/route";
import { UNIT_COST, request } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** Everything measured, and the part that reads the program's people (HLEN, HGETALL) with what counts it. */
const seen = { commands: 0, bytes: 0, hgetall: 0, readCommands: 0, readBytes: 0, publicTaken: 0 };
let measuring = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (measuring) {
    const bytes = Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies));
    seen.commands += commands.length;
    seen.bytes += bytes;
    const people = commands.some((c) => (c[0] === "HGETALL" || c[0] === "HLEN") && /^nl:aff:[^:]+:people$/.test(String(c[1])));
    const counting = commands.some((c) => (c[0] === "INCRBY" || c[0] === "DECRBY") && /^nl:traffic:r:/.test(String(c[1])));
    if (people || counting) {
      seen.readCommands += commands.length;
      seen.readBytes += bytes;
    }
    for (const c of commands) {
      if (c[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(c[1]))) seen.hgetall += 1;
      if (c[0] === "INCRBY" && /^nl:traffic:r:/.test(String(c[1]))) seen.publicTaken += Number(c[2]);
      if (c[0] === "DECRBY" && /^nl:traffic:r:/.test(String(c[1]))) seen.publicTaken -= Number(c[2]);
    }
  }
  return replies;
}) as typeof redis.pipeline;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "carver@example.com";
  await claimHandle(owner, "carvershop", "Carver store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1carversho9537", true);
  await setSubscription(owner, { customerId: "cus_carver", subscriptionId: "sub_carver", active: true, tier: "scale", period: paidPeriod() });
  const p = await addProduct(owner, "Spoon Course", "", "40");
  const q = await addProduct(owner, "Knife Course", "", "40");
  const P = p.ok ? p.product.id : "";
  const Q = q.ok ? q.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const statsId = (await store()).statsId as string;
  const people = `nl:aff:${statsId}:people`;
  const note = "\u0001".repeat(MAX_NOTE_LENGTH);
  const id = (n: number) => n.toString(16).padStart(12, "0");
  const person = (n: number, status: string, share: { percent: number; products: string[] } | null) =>
    JSON.stringify({ id: id(n), email: `person${n}@example.com`, code: `c${n}`, status, appliedAt: n, decidedAt: n, note, rate: null, paypal: "", share, cleared: null, by: null });
  const writes: (string | number)[][] = [["HSET", people, id(1), person(1, "approved", { percent: 50, products: [P] })]];
  for (let n = 2; n <= 990; n += 1) writes.push(["HSET", people, id(n), person(n, n % 2 ? "approved" : "removed", null)]);
  await real(writes);

  let tokens = 0;
  const invitation = async (email: string) => {
    const token = String(++tokens).padStart(64, "d");
    await real([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "", k: 1, p: { percent: 10, products: [Q] } }), "EX", 600]]);
    return token;
  };
  const open = async (token: string) =>
    openRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/open", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `handle=carvershop&token=${token}` }));
  const start = () => {
    Object.assign(seen, { commands: 0, bytes: 0, hgetall: 0, readCommands: 0, readBytes: 0, publicTaken: 0 });
    measuring = true;
  };

  part("1. Accepting by the emailed link: paid from the store's public requests, then given back down to the read");
  const first = await invitation("partner1@example.com");
  start();
  const opened = await open(first);
  measuring = false;
  console.log(`  link: ${seen.readCommands} commands and ${seen.readBytes} bytes reading the people; ${seen.publicTaken} public requests kept`);
  is("accepted", [opened.status, (opened.headers.get("location") ?? "").includes("status=joined"), (await affiliateByEmail(await store(), "partner1@example.com"))?.status], [303, true, "approved"]);
  is("the program read once", seen.hgetall, 1);
  is("the read inside the public requests taken first", request("light", seen.readCommands, seen.readBytes) <= seen.publicTaken * laterPageCost(), true);
  // The route's own public request (lib/metered-limits.ts withinStore, counted before this change too) and one rounding.
  is("no more kept than what was read, rounded up", seen.publicTaken <= bulkUnits(seen.readCommands, seen.readBytes) + 2, true);

  part("2. Accepting in the invited creator's studio: paid from their studio requests");
  const invitee = "whittler@example.com";
  await claimHandle(invitee, "whittlershop", "Whittler store", "");
  await ensureStoreId(invitee);
  await setSubscription(invitee, { customerId: "cus_whittler", subscriptionId: "sub_whittler", active: true, tier: "creator", period: paidPeriod() });
  const theirs = async () => (await storeForEmail(invitee))!;
  const offer = async () => {
    const made = await offerPartnership(invitee, { sid: (await store()).sid as string, storeName: "Carver store", handle: "carvershop", share: { percent: 10, products: [Q] }, titles: ["Knife Course"] });
    if (!made.ok) throw new Error("no offer");
    return made.id;
  };
  const cookie = `${SESSION_COOKIE}=${await openSession(invitee)}`;
  const answer = async (invite: string) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "answer", invite, accept: true }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const firstOffer = await offer();
  const used = await allowanceUsed(await theirs(), "studio");
  start();
  const answered = await answer(firstOffer);
  measuring = false;
  const units = (await allowanceUsed(await theirs(), "studio")) - used;
  console.log(`  studio: ${seen.commands} commands, ${seen.bytes} bytes; ${units} studio requests kept`);
  is("accepted", [answered.status, answered.body.ok, (await affiliateByEmail(await store(), invitee))?.status], [200, true, "approved"]);
  is("the program read once", seen.hgetall, 1);
  is("every command and byte inside the studio requests taken first", request("studio", seen.commands, seen.bytes) <= units * UNIT_COST.studio, true);
  is("no more kept than what was measured, rounded up", units <= bulkUnits(seen.commands, seen.bytes) + 2, true);

  part("3. With too few requests left, nothing is read or written, and the link or the offer is kept");
  const now = await store();
  const limit = publicVisitLimit(requestLimitFor(now));
  // A few left: the route's own request passes (withinStore), the read at its worst does not.
  const [, keys] = (await real([["SCAN", 0, "MATCH", "nl:traffic:r:*", "COUNT", 1000]]))[0] as [string, string[]];
  const counted = Number((await real([["GET", keys[0]]]))[0]) || 0;
  await takePublicRequest(now, "public", Date.now(), Math.max(1, limit - counted - 3), { shared: true });
  const third = await invitation("partner3@example.com");
  start();
  const refused = await open(third);
  measuring = false;
  is("the link's page says why", [refused.status, (refused.headers.get("location") ?? "").includes("status=resting")], [303, true]);
  is("nothing read", seen.hgetall, 0);
  is("nobody added", await affiliateByEmail(await store(), "partner3@example.com"), null);
  is("the link kept", typeof (await real([["GET", linkKey(third)]]))[0], "string");
  // Altered 2026-11-07 (rule 23): words that hold for every reason the requests were not taken, not only the month's.
  is("the page's words for it, in plain English", AFFILIATES_WORDS.en.notices.resting, {
    title: "This store can't take this right now",
    body: "Accepting checks the store's partners first, and the store can't take that many requests right now. Nothing was changed. Try again later, or write to the store.",
  });
  is("and in each of the store's languages", Object.values(AFFILIATES_WORDS).every((words) => typeof words.notices.resting?.title === "string"), true);

  const later = await offer();
  const left = await allowanceUsed(await theirs(), "studio");
  await takeAllowance(await theirs(), "studio", 2_000 - left - 2);
  start();
  const busy = await answer(later);
  measuring = false;
  is("the studio answers 429, nothing read", [busy.status, busy.body.error, seen.hgetall], [429, "studio_used", 0]);
  is("the offer kept", (await waitingOne(invitee, later)) !== null, true);
  done();
}
main();
