/**
 * The affiliate program's people, the program's terms and a partnership offer, read only in their exact shape
 * (CX-123 rules 24 and 30; docs/reviews/c5-sweep-app1.md findings 1, 9 and 10). Synthetic only: the in-memory Redis
 * double, through the real route app/api/store/affiliates/route.ts.
 *
 * 1. (ALTO, money) The cap on what one sale may promise (partners plus the affiliate commission, at most 90%,
 *    lib/partner-share.ts) is checked against listPartners = listAffiliates. A HGETALL reply that is not an even list
 *    of strings used to read as "nobody", so a second partner could be given 80% of a product already promising 80%
 *    to another (each sale then owed 160% of itself). Now listAffiliates throws UnknownReplyError, the route answers
 *    503 "unavailable" and saves nothing; the export, the hold release and the auto-approval fail closed too.
 * 2. Saving the program's terms re-reads the store; a lost re-read used to put a cut in force at once, skipping the
 *    notice promised to affiliates. Now nothing is saved.
 * 3. Accepting a partnership offer while the inviting store's id read is lost or fails used to delete the offer and
 *    say "gone". Now the offer is kept and the answer is 503 "unavailable"; only an exact "no such store" takes it out.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, listAffiliates, listPartners, openAffiliateLink, readAffiliate } from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { GET as exportRoute } from "@/app/api/store/affiliates/export/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Break = "none" | "people-queued" | "people-odd" | "people-object" | "reread" | "storeid-lost" | "storeid-throws";
let breakWhat: Break = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const people = one?.[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(one[1]));
  if (people && breakWhat === "people-queued") { await real(commands); return ["QUEUED"]; }
  if (people && breakWhat === "people-odd") { const [list] = (await real(commands)) as unknown[][]; return [[...list, "stray"]]; }
  if (people && breakWhat === "people-object") return [{ a: "b" }];
  if (breakWhat === "reread" && one?.[0] === "GET" && String(one[1]).startsWith("nl:store:owner:") && /storeForEmail[^\n]*\n\s+at async POST/.test(new Error().stack ?? "")) return [];
  if (breakWhat.startsWith("storeid") && one?.[0] === "GET" && String(one[1]).startsWith("nl:store:id:")) {
    if (breakWhat === "storeid-throws") throw new Error("Synthetic Redis failure reading the store id");
    return [];
  }
  return real(commands);
}) as typeof redis.pipeline;

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.padEnd(15, "x").slice(0, 15)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; accepted?: boolean } };
  };
  const exported = async () => {
    const response = await exportRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/export", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    return { status: response.status, type: response.headers.get("content-type") ?? "" };
  };
  return { post, exported };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "partners@example.com";
  const a = await shop(owner, "partnershop");
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await a.post(terms)).body.ok, true);
  const store = (await storeForEmail(owner))!;
  const first = await acceptPartnership(store, "first@example.com", { percent: 80, products: [product] });
  const second = await acceptPartnership(store, "second@example.com", { percent: 1, products: [product] });
  if (!first.ok || !second.ok) throw new Error("no partners");

  part("1. Healthy: the people are read in full, and the cap refuses a second 80%");
  is("both partners are listed", (await listPartners(store)).length, 2);
  const refused = await a.post({ action: "share", id: second.affiliate.id, percent: 80, products: [product] });
  is("refused by the cap", [refused.status, refused.body.error], [400, "share_committed"]);
  is("the second partner keeps 1%", (await readAffiliate(store, second.affiliate.id))?.share?.percent, 1);
  const allowed = await a.post({ action: "share", id: second.affiliate.id, percent: 5, products: [product] });
  is("a share inside the cap is saved", [allowed.status, allowed.body.ok], [200, true]);
  await a.post({ action: "share", id: second.affiliate.id, percent: 1, products: [product] });

  part("1. Unknown reply for the program's people: never 'nobody'");
  for (const shape of ["people-queued", "people-odd", "people-object"] as const) {
    breakWhat = shape;
    is(`${shape}: listAffiliates throws`, await thrown(() => listAffiliates(store)), "UnknownReplyError");
    is(`${shape}: listPartners throws`, await thrown(() => listPartners(store)), "UnknownReplyError");
    const share = await a.post({ action: "share", id: second.affiliate.id, percent: 80, products: [product] });
    const invite = await a.post({ action: "invite", email: "third@example.com", percent: 80, products: [product] });
    breakWhat = "none";
    is(`${shape}: the share is refused as unavailable`, [share.status, share.body.error], [503, "unavailable"]);
    is(`${shape}: the invitation is refused as unavailable`, [invite.status, invite.body.error], [503, "unavailable"]);
    is(`${shape}: the second partner still has 1%`, (await readAffiliate(store, second.affiliate.id))?.share?.percent, 1);
    const promised = (await listAffiliates(store)).reduce((sum, p) => sum + (p.share?.products.includes(product) ? p.share.percent : 0), 0);
    is(`${shape}: the product still promises partners 81%, never 160%`, promised, 81);
    is(`${shape}: nobody new was invited`, (await listAffiliates(store)).some((p) => p.email === "third@example.com"), false);
  }

  part("1. Rule 30: the other readers of the people fail closed");
  breakWhat = "people-queued";
  const release = await a.post({ action: "release", id: second.affiliate.id });
  breakWhat = "none";
  is("releasing a hold is refused as unavailable, nothing cleared", [release.status, release.body.error, (await readAffiliate(store, second.affiliate.id))?.cleared ?? null], [503, "unavailable", null]);

  const csv = await a.exported();
  is("healthy: the export is a spreadsheet", [csv.status, csv.type.startsWith("text/csv")], [200, true]);
  breakWhat = "people-queued";
  const blind = await a.exported();
  breakWhat = "none";
  is("the export is refused, never a spreadsheet without the program's people", [blind.status, blind.type.startsWith("text/csv")], [500, false]);

  // Approving every application at once checks first that the address is not one already on the list.
  const apply = async (email: string, token: string) => {
    const now = (await storeForEmail(owner))!;
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: now.statsId, e: email, n: "" }), "EX", 600]]);
    const result = await openAffiliateLink(now, token);
    return result.ok ? result.affiliate.status : result.reason;
  };
  const settled = (await storeForEmail(owner))!.affiliates;
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, ...settled, autoApprove: true });
  is("healthy: with approval at once, a new applicant is approved", await apply("fourth@example.com", "a".repeat(64)), "approved");
  breakWhat = "people-queued";
  const unread = await apply("fifth@example.com", "b".repeat(64));
  breakWhat = "none";
  is("the list could not be checked for the same inbox: the application waits for the creator", unread, "pending");
  await setAffiliateSetting(owner, { ...settled });

  part("2. Healthy: a cut saved with 30 days' notice waits");
  // Rule 23 (#2995 follow-up): raising the commission is now checked against the 90% cap, and the course's partners
  // (80 + 1%) would make 30% promise 111% of a sale. They are removed first, so what is tested here stays the notice.
  for (const partner of [first, second]) if (partner.ok) await a.post({ action: "remove", id: partner.affiliate.id });
  is("(raised to 30%: nobody shares in the course any more)", (await a.post({ ...terms, percent: 30, notice: 30 })).body.ok, true);
  is("saved with notice", (await a.post({ ...terms, percent: 10, notice: 30 })).body.ok, true);
  const waiting = (await storeForEmail(owner))!.affiliates;
  is("today 30%, 10% pending", [waiting.percent, waiting.pending?.percent], [30, 10]);

  part("2. The route's second read of the store is lost: nothing is saved");
  await a.post({ ...terms, percent: 30, notice: 30 });
  const reset = (await storeForEmail(owner))!.affiliates;
  is("(back to 30%, nothing pending)", [reset.percent, reset.pending ?? null], [30, null]);
  breakWhat = "reread";
  const cut = await a.post({ ...terms, percent: 10, notice: 30 });
  breakWhat = "none";
  const now = (await storeForEmail(owner))!.affiliates;
  is("refused as unavailable", [cut.status, cut.body.error], [503, "unavailable"]);
  is("the terms are as they were: 30% today, nothing pending, the notice not skipped", [now.percent, now.pending ?? null], [30, null]);

  part("3. Answering an invitation while the inviting store's id read is lost or fails");
  // A product of its own, as before: an acceptance is checked against the cap again
  // (tests/affiliate-partner-accept-cap.test.ts), and this keeps it clear of the course's history.
  const other = await addProduct(owner, "Pan Sauces", "", "40");
  const spare = other.ok ? other.product.id : "";
  const invited = "guest@example.com";
  const b = await shop(invited, "guestshop");
  const offer = async (sid = store.sid) => {
    const o = await offerPartnership(invited, { sid, storeName: store.name, handle: store.handle, share: { percent: 5, products: [spare] }, titles: ["Pan Sauces"] });
    if (!o.ok) throw new Error("no offer");
    return o.id;
  };
  const decline = await b.post({ action: "answer", invite: await offer(), accept: false });
  is("healthy: a declined offer is answered and taken out", [decline.body.ok, (await waitingFor(invited)).length], [true, 0]);
  for (const as of ["storeid-lost", "storeid-throws"] as const) {
    const id = await offer();
    breakWhat = as;
    const answered = await b.post({ action: "answer", invite: id, accept: true });
    breakWhat = "none";
    is(`${as}: the creator is told it could not be done now, not "gone"`, [answered.status, answered.body.error], [503, "unavailable"]);
    is(`${as}: the offer is kept`, (await waitingFor(invited)).map((w) => w.id), [id]);
    const again = await b.post({ action: "answer", invite: id, accept: true });
    is(`${as}: answered again once the read works, the partnership is made`, [again.status, again.body.accepted], [200, true]);
    is(`${as}: and the offer is taken out`, (await waitingFor(invited)).length, 0);
  }
  const ghost = await offer("0".repeat(32));
  const answered = await b.post({ action: "answer", invite: ghost, accept: true });
  is("healthy: an offer from a store that does not exist is gone and taken out", [answered.status, answered.body.error, (await waitingFor(invited)).length], [400, "gone", 0]);
  done();
}
main();
