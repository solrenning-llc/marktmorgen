/**
 * 232 [CA1] unit 4b2: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), moving a store from another platform is work
 * nobody is paying for. The import routes refuse to start, check
 * or move on, and say why; an upload under way is queued, not lost; an
 * import already started keeps its place (its record kept alive) and
 * goes on where it stopped once the plan is paid again; canceling, reading
 * where it stands and the report stay open; the five-minute job does not
 * work on it; and the allowance a paused plan shows is Store's, not its own.
 * Since the original unit 4c (12/11/2026), the same once the plan is not
 * running at all (lib/plan-standing.ts newCostCode, "plan_ended").
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GET as importGet, POST as importPost } from "@/app/api/store/import/route";
import { POST as funnelPost } from "@/app/api/store/import/funnel/route";
import { MAX_STORE_BYTES, claimHandle, ensureListId, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import * as imports from "@/lib/imports";
import { IMPORT_KEEP_SECONDS, RAW_DAYS, advanceImports, jobOf, runImport, startImport } from "@/lib/imports";
import { COST_LINES } from "./plan-cost-registry";
import { FUNNEL_PAUSED, IMPORTS_PAUSED, IMPORT_ALLOWANCES, IMPORT_ROWS_KEPT_DAYS, importAllowanceFor } from "@/lib/import-limits";
import { costsPaused, newCostCode } from "@/lib/plan-standing";
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

  part("The plan is not running: an upload under way finishes queued, and the import waits (the original 4c)");
  const ENDED = "import-ended@example.com";
  await claimHandle(ENDED, "import-ended", "Import Ended Shop", "");
  await ensureStatsId(ENDED);
  await ensureListId(ENDED);
  cookie = `${SESSION_COOKIE}=${await openSession(ENDED)}`;
  await setSubscription(ENDED, { customerId: "cus_ImportEnded0001", subscriptionId: "sub_ImportEnded0001", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  let ended = (await storeForEmail(ENDED))!;
  const third = await startImport(ended, ENDED, "contacts", INPUT);
  if (!third.ok) throw new Error(`not started: ${third.reason}`);
  const endedId = third.job.id;
  is("its rows arrive while paid", (await post(importPost, "/api/store/import", { action: "rows", id: endedId, rows: ROWS })).status, 200);
  await setSubscription(ENDED, { active: false, period: null });
  ended = (await storeForEmail(ENDED))!;
  is("the plan is not running", [costsPaused(ended), newCostCode(ended)], [false, "plan_ended"]);
  const endedFinish = await post(importPost, "/api/store/import", { action: "finish", id: endedId });
  is("finishing the upload queues it, with nothing applied", [endedFinish.status, ((await endedFinish.json()) as { import?: { state?: string } }).import?.state, (await jobOf(ended, endedId))?.done], [200, "queued", 0]);
  // lib/request-guard.ts withinMonth's own key: finishing spends none of the month's steps on a plan not running.
  const month = windowId(ended);
  const stepKey = `nl:rlm:import-step-month:${createHash("sha256").update(`nimbus-import-step-month:${ended.sid}`).digest("hex").slice(0, 32)}:${month}`;
  is("the month's import steps are a counted window here", typeof month, "string");
  is("and finishing took none of them", await redis.pipeline([["GET", stepKey]]), [null]);
  const endedStep = await runImport(endedId, Date.now() + 30_000);
  is("a step does no work and keeps the job", [endedStep?.state, endedStep?.done, endedStep?.counts.added], ["queued", 0, 0]);
  await advanceImports(Date.now() + 30_000);
  is("the five-minute job leaves it queued", [(await jobOf(ended, endedId))?.state, (await jobOf(ended, endedId))?.done], ["queued", 0]);
  is("no contact was added", await redis.pipeline([["HLEN", leadsKey(ended.listId!)]]), [0]);
  for (const [label, body] of [
    ["start", { action: "start", kind: "contacts", ...INPUT }],
    ["dry run", { action: "preview", kind: "contacts", ...INPUT, rows: ROWS }],
    ["step", { action: "step", id: endedId }],
  ] as const) {
    const res = await post(importPost, "/api/store/import", body as Record<string, unknown>);
    is(`${label}: 409 plan_ended`, [res.status, await errorOf(res)], [409, "plan_ended"]);
  }
  const endedOne = await importGet(new NextRequest(`https://marktmorgen.com/api/store/import?id=${endedId}`, { headers: { cookie, host: "marktmorgen.com" } }));
  is("where it stands still reads", [endedOne.status, ((await endedOne.json()) as { import?: { state?: string } }).import?.state], [200, "queued"]);

  part("A paused import's passes are priced (Codex L on #3980, L-20261118-1452)");
  // Each five-minute pass over it, until it ends, costs commands and reads the store: counted here, and priced in the
  // imports line of tests/plan-cost-registry.ts for every one of the passes its keeping allows.
  const named = imports as unknown as Record<string, unknown>;
  const passCommands = named.PAUSED_IMPORT_PASS_COMMANDS;
  const passes = named.PAUSED_IMPORT_PASSES;
  const measured = await (async () => {
    const real = redis.pipeline.bind(redis);
    let commands = 0;
    let bytes = 0;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      commands += batch.length;
      const replies = await real(batch);
      bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(replies ?? null));
      return replies;
    }) as typeof redis.pipeline;
    try {
      await advanceImports(Date.now() + 30_000);
    } finally {
      redis.pipeline = real;
    }
    return { commands, bytes };
  })();
  is("(control) the pass left it waiting", (await jobOf(ended, endedId))?.state, "queued");
  is(`a pass's commands are within PAUSED_IMPORT_PASS_COMMANDS (measured ${measured.commands})`, typeof passCommands === "number" && measured.commands <= passCommands, true);
  const passBytes = named.PAUSED_IMPORT_PASS_BYTES;
  is(`and its bytes within PAUSED_IMPORT_PASS_BYTES, a whole store record's worst included (measured ${measured.bytes})`, typeof passBytes === "number" && measured.bytes <= passBytes && passBytes >= MAX_STORE_BYTES, true);
  is("every pass its keeping allows, one every five minutes, ends included", passes, Math.floor(IMPORT_KEEP_SECONDS / 300) + 1);
  const line = COST_LINES.find((l) => l.id === "imports");
  is("and the imports line names all three", ["PAUSED_IMPORT_PASSES", "PAUSED_IMPORT_PASS_COMMANDS", "PAUSED_IMPORT_PASS_BYTES"].every((name) => line?.sources.some((src) => src.file === "lib/imports.ts" && src.names.includes(name))), true);

  part("A paused import waits as long as its own record is kept, never longer (Claude 7 on #3980, reconfirmed by Claude 4 and Codex N1)");
  // Each five-minute pass of a paused import writes its record and renews its keys; on a store nobody pays that was
  // forever. Past IMPORT_KEEP_SECONDS from its start it ends, says so, and leaves the job's line.
  const kept = (await redis.pipeline([["GET", `nl:import:${endedId}`]]))[0] as string;
  const aged = JSON.parse(kept) as { at: number };
  aged.at = Date.now() - (IMPORT_KEEP_SECONDS + 3600) * 1000;
  await redis.pipeline([["SET", `nl:import:${endedId}`, JSON.stringify(aged)]]);
  // The pass that ends it, counted as the five-minute job makes it (its list read and its record read before runImport).
  const realPipeline = redis.pipeline.bind(redis);
  let endCommands = 2;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    endCommands += batch.length;
    return realPipeline(batch);
  }) as typeof redis.pipeline;
  let lapsed: Awaited<ReturnType<typeof runImport>>;
  try {
    lapsed = await runImport(endedId, Date.now() + 30_000);
  } finally {
    redis.pipeline = realPipeline;
  }
  const passLimit = (imports as unknown as Record<string, unknown>).PAUSED_IMPORT_PASS_COMMANDS;
  is(`the pass that ends it is within PAUSED_IMPORT_PASS_COMMANDS too (measured ${endCommands})`, typeof passLimit === "number" && endCommands <= passLimit, true);
  is("it ends as failed, with nothing applied", [lapsed?.state, lapsed?.done], ["failed", 0]);
  is("it leaves the five-minute job's line", await redis.pipeline([["SISMEMBER", "nl:imports:active", endedId]]), [0]);
  is("and the next pass writes nothing more", (await runImport(endedId, Date.now() + 30_000))?.state, "failed");
  // Codex L on #3980 (LEVE): a plan that ended, or that the creator paused, was not necessarily left unpaid.
  const said = String((await redis.pipeline([["LRANGE", `nl:import:${endedId}:errors`, 0, -1]]))[0] ?? "");
  is("the words do not say the plan was unpaid when it ended", [/not paid/.test(said), /plan/.test(said)], [false, true]);

  part("What the creator is told");
  is("the days the words promise are the days the rows are kept", IMPORT_ROWS_KEPT_DAYS, RAW_DAYS);
  for (const words of [IMPORTS_PAUSED.renewal_unpaid, IMPORTS_PAUSED.plan_disputed, IMPORTS_PAUSED.plan_ended]) is("the import words say imports are paused and nothing brought in is lost", /imports are paused/.test(words) && /already brought in stays/.test(words), true);
  for (const words of [FUNNEL_PAUSED.renewal_unpaid, FUNNEL_PAUSED.plan_disputed, FUNNEL_PAUSED.plan_ended]) is("the funnel words say so too", /funnel imports are paused/.test(words), true);
  is("the studio notice, the email and the Terms name imports (renewal)", RENEWAL_PAUSED_WORDS.includes("imports from other platforms"), true);
  is("the same for a dispute", DISPUTE_PAUSED_WORDS.includes("imports from other platforms"), true);

  done();
}

main();
