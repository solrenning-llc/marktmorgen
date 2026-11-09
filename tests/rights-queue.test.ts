/**
 * A deletion scheduled because the month's rights budget was used up
 * (lib/rights-budget.ts) is done by itself, by the hourly job
 * (app/api/cron/rights), within the month the law gives (GDPR art. 12(3),
 * app/privacy/page.tsx: "typically one month under the GDPR"):
 *
 *   (a) nothing is done before it is due, and nothing is marked done;
 *   (b) once the next month's budget opens, the plan pays and it is done, the
 *       store's owner told as for any deletion the person asked for;
 *   (c) when that budget is used up too, a few days before the deadline the
 *       company's budget pays for it;
 *   (d) and when the company's is used up as well, it is still done before
 *       the deadline (a legal duty, owner's decision 9), counted past the cap
 *       and said in the log, never hidden;
 *   (e) the hourly job is scheduled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/rights/route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { erasePerson } from "@/lib/person-erasure";
import { runRightsQueue } from "@/lib/rights-queue";
import { RIGHTS_COMPANY_UNITS, RIGHTS_DEADLINE_MARGIN_MS, legalDeadline, nextRightsMonth, rightsMonth } from "@/lib/rights-budget-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const told: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    told.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: `email_${told.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const SPENT = "999999999";
const HOUR = 3_600_000;

async function storeFor(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  // Paid well past next month, so the plan is still the payer when the job runs.
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 10, ahead: 80 }) });
  return (await storeForEmail(owner))!;
}

const contactOf = (store: Store, email: string) => redis.run(["HEXISTS", leadsKey(store.listId!), email]) === 1;
const count = (key: string) => Number(redis.run(["GET", key]) ?? 0);
const ownerToldAbout = (email: string) => told.some((body) => body.includes("A person deleted their data") && body.includes(email));

async function main(): Promise<void> {
  redis.clear();
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "synthetic-rights-queue-key-32-characters!";
  delete process.env.CRON_SECRET;
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const asked = Date.now();
    const next = nextRightsMonth(asked);
    const deadline = legalDeadline(asked);
    const store = await storeFor("rightsqueue");
    redis.run(["SET", `nl:rights:s:${store.sid}:${rightsMonth(asked)}`, SPENT]);

    part("(a) Scheduled, and nothing is done before it is due");
    const ann = "ann@example.com";
    await upsertContact(store.listId!, ann, { agreed: true, explicit: true, source: "free" }, ROOM);
    const first = await erasePerson(store, ann, { kind: "person" }, { now: asked });
    is("scheduled", first.ok ? "ok" : first.reason, "scheduled");
    is("by the legal deadline", !first.ok && "by" in first ? first.by : null, deadline);
    is("the deadline is one month after asking, and the next month opens before it", next <= deadline, true);
    const early = await runRightsQueue(asked + HOUR);
    is("an hour later, before the next month, nothing is done", early.done, 0);
    is("the contact is still there", contactOf(store, ann), true);

    part("(b) The next month's budget opens: the plan pays, it is done, the owner is told");
    const opened = await runRightsQueue(next + HOUR);
    is("done by the job", opened.done, 1);
    is("the contact is gone", contactOf(store, ann), false);
    is("the plan's budget of the new month paid", count(`nl:rights:s:${store.sid}:${rightsMonth(next)}`) > 0, true);
    is("not the company's", count(`nl:rights:co:${rightsMonth(next)}`), 0);
    is("the store's owner is told, as for any deletion the person asked for", ownerToldAbout(ann), true);
    const again = await runRightsQueue(next + 2 * HOUR);
    is("the queue is empty after it", again.done + again.waiting, 0);

    part("(c) That budget used up too: a few days before the deadline, the company pays");
    const ben = "ben@example.com";
    await upsertContact(store.listId!, ben, { agreed: true, explicit: true, source: "free" }, ROOM);
    is("scheduled", (await erasePerson(store, ben, { kind: "person" }, { now: asked })).ok, false);
    redis.run(["SET", `nl:rights:s:${store.sid}:${rightsMonth(next)}`, SPENT]);
    const waited = await runRightsQueue(next + HOUR);
    if (deadline - RIGHTS_DEADLINE_MARGIN_MS > next + HOUR) {
      is("not yet near the deadline: it waits", [waited.done, contactOf(store, ben)], [0, true]);
    }
    const near = deadline - RIGHTS_DEADLINE_MARGIN_MS + HOUR;
    const reserve = await runRightsQueue(near);
    is("near the deadline, done", reserve.done, 1);
    is("the contact is gone", contactOf(store, ben), false);
    is("the company's budget paid", count(`nl:rights:co:${rightsMonth(near)}`) > 0, true);
    is("within its cap", count(`nl:rights:co:${rightsMonth(near)}`) <= RIGHTS_COMPANY_UNITS, true);

    part("(d) The company's used up as well: still done before the deadline, counted past the cap and said");
    const cal = "cal@example.com";
    await upsertContact(store.listId!, cal, { agreed: true, explicit: true, source: "free" }, ROOM);
    is("scheduled", (await erasePerson(store, cal, { kind: "person" }, { now: asked })).ok, false);
    redis.run(["SET", `nl:rights:co:${rightsMonth(near)}`, String(RIGHTS_COMPANY_UNITS)]);
    const forced = await runRightsQueue(near + HOUR);
    is("done before the deadline", [forced.done, near + HOUR < deadline], [1, true]);
    is("the contact is gone", contactOf(store, cal), false);
    is("counted past the company's cap, never hidden", count(`nl:rights:co:${rightsMonth(near)}`) > RIGHTS_COMPANY_UNITS, true);
    is("and said in the log", errors.some((line) => /past the company's rights cap/i.test(line)), true);

    part("(e) The hourly job answers and is scheduled");
    const response = await GET(new NextRequest("https://marktmorgen.com/api/cron/rights"));
    is("it answers", response.status, 200);
    const crons = (JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
    is("vercel.json runs it every hour", crons.some((c) => c.path === "/api/cron/rights" && /^\d+ \* \* \* \*$/.test(c.schedule)), true);
  } finally {
    console.error = error;
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
