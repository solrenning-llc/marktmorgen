/**
 * 232 [CA1] unit 4b2: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), moving a store from another platform is work
 * nobody is paying for. The import routes refuse to start, check
 * or move on, and say why; an upload under way is queued, not lost; an
 * import already started keeps its place (its record kept alive) and
 * goes on where it stopped once the plan is paid again; canceling, reading
 * where it stands and the report stay open; the five-minute job does not
 * work on it; and the allowance a paused plan shows is Store's, not its own.
 */
import { NextRequest } from "next/server";
import { GET as importGet, POST as importPost } from "@/app/api/store/import/route";
import { POST as funnelPost } from "@/app/api/store/import/funnel/route";
import { claimHandle, ensureListId, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { RAW_DAYS, advanceImports, jobOf, runImport, startImport } from "@/lib/imports";
import { FUNNEL_PAUSED, IMPORTS_PAUSED, IMPORT_ALLOWANCES, IMPORT_ROWS_KEPT_DAYS, importAllowanceFor } from "@/lib/import-limits";
import { costsPaused } from "@/lib/plan-standing";
import { leadsKey } from "@/lib/contacts";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { paidPeriod } from "./billing-period-fixture";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "import-paused@example.com";
let cookie = "";

function post(route: typeof importPost, path: string, body: Record<string, unknown>) {
  return route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: JSON.stringify(body) }));
}
const errorOf = async (res: Response) => ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;

const ROWS = [
  ["2", "ada@example.com", "Ada", "", "Subscribed"],
  ["3", "bea@example.com", "Bea", "", "Subscribed"],
  ["4", "cy@example.com", "Cy", "", "Subscribed"],
];
const INPUT = { expected: ROWS.length, file: "contacts.csv", agreed: true, consentColumn: true, tags: [], source: "clickfunnels" as const };

async function main() {
  redis.clear();
  await claimHandle(OWNER, "import-paused", "Import Paused Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  part("Paid up: an import starts, and the plan's own figures apply");
  await setSubscription(OWNER, { customerId: "cus_ImportPaused01", subscriptionId: "sub_ImportPaused01", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  let store = (await storeForEmail(OWNER))!;
  is("costs not paused", costsPaused(store), false);
  is("Studio's rows while paid", importAllowanceFor(store).rows, IMPORT_ALLOWANCES.pro.rows);
  const started = await startImport(store, OWNER, "contacts", INPUT);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  const id = started.job.id;
  is("receiving its rows", started.job.state, "receiving");

  part("Renewal unpaid: an upload already under way is queued, not lost");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  is("costs paused", costsPaused(store), true);
  // Store's 1,000 rows of the month already counted: the upload under way still has its plan's month.
  await redis.pipeline([["SET", `nl:imports:rows:${store.sid}:${windowId(store)}`, String(IMPORT_ALLOWANCES.creator.rows)]]);
  const sent = await post(importPost, "/api/store/import", { action: "rows", id, rows: ROWS });
  is("its rows are taken against the plan's own month, not Store's", sent.status, 200);
  const closed = await post(importPost, "/api/store/import", { action: "finish", id });
  is("and its upload finishes, queued with nothing applied", [closed.status, ((await closed.json()) as { import?: { state?: string; done?: number } }).import?.state, (await jobOf(store, id))?.done], [200, "queued", 0]);

  part("Renewal unpaid: the import waits where it is");
  is("Store's rows while paused, not Studio's", importAllowanceFor(store).rows, IMPORT_ALLOWANCES.creator.rows);
  await redis.pipeline([["EXPIRE", `nl:import:${id}`, 60], ["EXPIRE", `nl:imports:busy:${store.sid}`, 60]]);
  const waited = await runImport(id, Date.now() + 30_000);
  const [ttl] = await redis.pipeline([["TTL", `nl:import:${id}`]]);
  is("a paused pass keeps the import's record alive for its 14 days", Number(ttl) > 13 * 86_400, true);
  const [busyTtl] = await redis.pipeline([["TTL", `nl:imports:busy:${store.sid}`]]);
  is("and the store's one-import slot with it", Number(busyTtl) > 13 * 86_400, true);
  is("a step does no work and keeps the job", [waited?.state, waited?.done, waited?.counts.added], ["queued", 0, 0]);
  const cron = await advanceImports(Date.now() + 30_000);
  is("the five-minute job leaves it queued", [(await jobOf(store, id))?.state, (await jobOf(store, id))?.done], ["queued", 0]);
  is("and finishes nothing", cron.finished, 0);
  const contactsBefore = await redis.pipeline([["HLEN", leadsKey(store.listId!)]]);

  part("Renewal unpaid: the routes refuse new work and say why");
  for (const [label, body] of [
    ["start", { action: "start", kind: "contacts", ...INPUT }],
    ["dry run", { action: "preview", kind: "contacts", ...INPUT, rows: ROWS }],
    ["step", { action: "step", id }],
  ] as const) {
    const res = await post(importPost, "/api/store/import", body as Record<string, unknown>);
    is(`${label}: 409 renewal_unpaid`, [res.status, await errorOf(res)], [409, "renewal_unpaid"]);
  }
  is("the step route did not move the job", (await jobOf(store, id))?.done, 0);
  is("no contact was added while paused", await redis.pipeline([["HLEN", leadsKey(store.listId!)]]), contactsBefore);
  const funnel = await post(funnelPost, "/api/store/import/funnel", { action: "page", html: "<html><body>Hi</body></html>", file: "a.html" });
  is("a funnel migration is refused too", [funnel.status, await errorOf(funnel)], [409, "renewal_unpaid"]);

  part("Renewal unpaid: what stays open");
  const cancelUnknown = await post(importPost, "/api/store/import", { action: "cancel", id: "a".repeat(id.length) });
  is("canceling is not refused for the pause (an unknown import is 404, not 409)", cancelUnknown.status, 404);
  const list = await importGet(new NextRequest("https://marktmorgen.com/api/store/import", { headers: { cookie, host: "marktmorgen.com" } }));
  is("the list of imports still reads", list.status, 200);
  const one = await importGet(new NextRequest(`https://marktmorgen.com/api/store/import?id=${id}`, { headers: { cookie, host: "marktmorgen.com" } }));
  is("and so does where one stands", [one.status, ((await one.json()) as { import?: { state?: string } }).import?.state], [200, "queued"]);

  part("Paid again: the import goes on where it stopped");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 5 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  is("done, every row looked at", [job?.state, job?.done, job?.counts.added], ["done", 3, 3]);
  const allowed = await post(importPost, "/api/store/import", { action: "preview", kind: "contacts", ...INPUT, rows: ROWS });
  is("a dry run is answered again", allowed.status, 200);

  part("A plan payment disputed with the bank pauses imports the same way");
  const disputed = await recordPlanDispute(storeRef(store), { id: "du_ImportPaused0001", status: "open", at: Math.floor(Date.now() / 1000), coversUntil: Math.floor(Date.now() / 1000) + 30 * 86_400 });
  is("the dispute is written down", Boolean(disputed), true);
  store = (await storeForEmail(OWNER))!;
  is("costs paused by the dispute", costsPaused(store), true);
  is("Store's figures while disputed", importAllowanceFor(store).starts, IMPORT_ALLOWANCES.creator.starts);
  const second = await post(importPost, "/api/store/import", { action: "start", kind: "contacts", ...INPUT });
  is("start: 409 plan_disputed", [second.status, await errorOf(second)], [409, "plan_disputed"]);
  const funnel2 = await post(funnelPost, "/api/store/import/funnel", { action: "page", html: "<html></html>", file: "a.html" });
  is("funnel: 409 plan_disputed", [funnel2.status, await errorOf(funnel2)], [409, "plan_disputed"]);

  part("What the creator is told");
  is("the days the words promise are the days the rows are kept", IMPORT_ROWS_KEPT_DAYS, RAW_DAYS);
  for (const words of [IMPORTS_PAUSED.renewal_unpaid, IMPORTS_PAUSED.plan_disputed]) is("the import words say imports are paused and nothing brought in is lost", /imports are paused/.test(words) && /already brought in stays/.test(words), true);
  for (const words of [FUNNEL_PAUSED.renewal_unpaid, FUNNEL_PAUSED.plan_disputed]) is("the funnel words say so too", /funnel imports are paused/.test(words), true);
  is("the studio notice, the email and the Terms name imports (renewal)", RENEWAL_PAUSED_WORDS.includes("imports from other platforms"), true);
  is("the same for a dispute", DISPUTE_PAUSED_WORDS.includes("imports from other platforms"), true);

  done();
}

main();
