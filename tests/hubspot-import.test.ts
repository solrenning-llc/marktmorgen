/**
 * Moving deals from HubSpot into the store's CRM (lib/hubspot-import.ts,
 * app/api/store/import/hubspot), through the real module and route with
 * the in-memory Redis double and synthetic stores, files and addresses
 * (example.com) only. What is checked:
 *
 *   - a deal's id is worked out from HubSpot's Record ID, always the same;
 *     its note keeps the Record ID and the close date;
 *   - the dry run says what would happen and writes nothing;
 *   - pipelines and stages the store does not have are made, the ones it
 *     has (any case) are used, a won or lost stage goes to the pipeline's
 *     own; nothing existing is renamed; deals come in with and without an
 *     amount, the reasons in the notices;
 *   - the same file twice adds nothing the second time;
 *   - the plan's pipelines and MAX_STAGES are kept to, the deals past them
 *     refused with what to do;
 *   - a file past the store's deals, its data room or the month's rows is
 *     refused whole, nothing written, the data room given back;
 *   - the data room is taken for what is written;
 *   - one import at a time: a second one waits for the lock, then is
 *     refused; pipelines changed meanwhile are never overwritten;
 *   - a role that may not import, and no session, are refused.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/import/hubspot/route";
import { POST as CRM_POST } from "@/app/api/store/crm/route";
import { crmAnswer } from "@/lib/crm-response";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CRM_LOCK_WAIT_MS, IMPORT_CRM_DEALS, dealCount, readDeal, readDeals, readOpportunityReview, readPipelines, savePipelineChange, takeCrmLock, writeDeal } from "@/lib/crm";
import { MAX_DEALS, MAX_STAGES, PIPELINES_BY_TIER, allStages } from "@/lib/crm-rules";
import { STAGE_PAST_REASON, pipelineRoomReason } from "@/lib/hubspot-csv";
import { HUBSPOT_IMPORT_WORDS, type HubSpotImportResult, hubSpotDealId, hubSpotDealNote, importHubSpotDeals } from "@/lib/hubspot-import";
import { takeImportRows } from "@/lib/imports";
import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { LockBusyError, releaseLock } from "@/lib/redis-lock";
import { windowId } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { TAKE_DATA, dataKey, dataUsed, noteData, takeData } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const HEADER = ["Record ID", "Deal name", "Deal stage", "Pipeline", "Amount", "Close date", "Deal owner", "Associated Contact"];
const row = (id: string, title: string, stage: string, pipeline: string, amount = "", close = "", contact = "") => [id, title, stage, pipeline, amount, close, "Someone", contact];

let n = 0;
async function paidStore(handle: string): Promise<{ store: Store; owner: string; session: string }> {
  const owner = `${handle}@example.com`;
  n += 1;
  await claimHandle(owner, handle, `${handle} studio`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1TestHubs0000${n}`, true);
  await setSubscription(owner, { customerId: `cus_Hubs000${n}`, subscriptionId: `sub_Hubs000${n}`, active: true, tier: "creator", period: paidPeriod() });
  await setMailSettings(owner, { fromName: `${handle} studio`, address: "1 Main St, Portland, OR 97201" });
  return { store: (await storeForEmail(owner))!, owner, session: await openSession(owner) };
}

/**
 * IMPORT_CRM_DEALS (lib/crm.ts) as Redis runs it, for the in-memory store this test uses: its own shim, so
 * lib/redis-memory.ts stays as it is on main. All or nothing: -4 when the CRM lock is not the import's own, -1
 * when the pipelines changed, -2 when an id is taken (with each one there), -3 past the ceiling; otherwise the
 * pipelines (when sent) and every deal.
 */
function runDealsImportLikeRedis(): void {
  const plain = redis.pipeline.bind(redis);
  const isImport = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]) === IMPORT_CRM_DEALS && c[2] === 4 && c.length >= 12 && (c.length - 12) % 2 === 0;
  const run = async (c: (string | number)[]): Promise<unknown> => {
    const [deals, pipes, stages, lock, expected, next, copy, max, token, ...pairs] = c.slice(3).map(String);
    const [held] = await plain([["GET", pipes]]);
    const current = typeof held === "string" ? held : "";
    const ids = pairs.filter((_, i) => i % 2 === 0);
    const taken: string[] = [];
    for (const id of ids) {
      const [there] = await plain([["HGET", deals, id]]);
      if (typeof there === "string") taken.push(id, there);
    }
    // Only while the store's CRM lock is still the import's own, in the same step as the write (Codex J on #2048).
    const [owner] = await plain([["GET", lock]]);
    if (owner !== token) return [-4, current, ...taken];
    if (current !== expected) return [-1, current, ...taken];
    if (taken.length) return [-2, current, ...taken];
    const [size] = await plain([["HLEN", deals]]);
    if (Number(size) + ids.length > Number(max)) return [-3, current];
    if (next !== "") await plain([["SET", pipes, next], ["SET", stages, copy]]);
    if (pairs.length) await plain([["HSET", deals, ...pairs]]);
    return [ids.length];
  };
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!commands.some(isImport)) return plain(commands);
    const out: unknown[] = [];
    for (const c of commands) out.push(...(isImport(c) ? [await run(c)] : await plain([c])));
    return out;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  runDealsImportLikeRedis();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_hubspot_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_hubspot_only_a_stand_in";

  part("A deal's id and note");
  is("the same Record ID is always the same deal id", [hubSpotDealId("1001"), hubSpotDealId("1001") === hubSpotDealId("1001")], [hubSpotDealId("1001"), true]);
  is("ten letters and digits, like every deal id", /^[a-z0-9]{10}$/.test(hubSpotDealId("1001")), true);
  is("another Record ID is another deal", hubSpotDealId("1001") === hubSpotDealId("1002"), false);
  is("a closed deal's note", hubSpotDealNote("1001", "2026-10-01", true), "From HubSpot, Record ID 1001.\nClosed on 2026-10-01 (from HubSpot).");
  is("an open deal's close date is when it is expected to close", hubSpotDealNote("1002", "2026-12-01", false), "From HubSpot, Record ID 1002.\nExpected to close on 2026-12-01 (from HubSpot).");
  is("no close date, no line for it", hubSpotDealNote("1003", null, false), "From HubSpot, Record ID 1003.");

  const { store, session } = await paidStore("hubs");
  const statsId = store.statsId!;
  const call = async (body: Record<string, unknown>, token = session, sid = "") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.cookie = SESSION_COOKIE + "=" + token;
    if (sid) headers["x-nimbus-store"] = sid;
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/import/hubspot", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const first = {
    header: HEADER,
    currency: "usd",
    rows: [
      row("1001", "Acme retainer", "Appointment scheduled", "Sales Pipeline", "1500", "2026-12-01", "Ada Lovelace (ada@example.com)"),
      row("1002", "Beta workshop", "Contract sent", "Sales Pipeline", "", "", ""),
      row("1003", "Gamma course", "Closed won", "Sales Pipeline", "EUR 900", "2026-10-01", "grace@example.com; lin@example.com"),
    ],
  };

  part("The dry run says what would happen and writes nothing");
  const before = await dataUsed(store);
  const dry = await call({ action: "check", ...first });
  is("the dry run answers", [dry.status, dry.body.summary?.written, dry.body.summary?.added, dry.body.summary?.alreadyThere], [200, false, 3, 0]);
  is("with the pipeline it would make, its won and lost stages included", dry.body.summary?.pipelinesCreated, [{ name: "Sales Pipeline", stages: ["Appointment scheduled", "Contract sent", "Closed won", "Lost"] }]);
  is("nothing is written: the board is the one the store always had", [(await readPipelines(statsId)).map((p) => p.name), await dealCount(statsId)], [["Sales"], 0]);
  is("and no room is taken", (await dataUsed(store))?.used, before?.used);

  part("Pipelines, stages and deals are made");
  const saved = await call({ action: "save", ...first });
  is("saved", [saved.status, saved.body.summary?.written, saved.body.summary?.added, saved.body.summary?.alreadyThere], [200, true, 3, 0]);
  const pipelines = await readPipelines(statsId);
  is("the store's own pipeline is kept and the file's is made", pipelines.map((p) => [p.name, p.stages.map((s) => `${s.name}:${s.kind}`)]), [
    ["Sales", ["New:open", "Talking:open", "Offer sent:open", "Won:won", "Lost:lost"]],
    ["Sales Pipeline", ["Appointment scheduled:open", "Contract sent:open", "Closed won:won", "Lost:lost"]],
  ]);
  const stageName = (id: string) => allStages(pipelines).find((s) => s.id === id)?.name;
  const deals = (await readDeals(statsId, allStages(pipelines))).sort((a, b) => a.title.localeCompare(b.title));
  is("each deal in its stage, with its id from the Record ID", deals.map((d) => [d.id, d.title, stageName(d.stage)]), [
    [hubSpotDealId("1001"), "Acme retainer", "Appointment scheduled"],
    [hubSpotDealId("1002"), "Beta workshop", "Contract sent"],
    [hubSpotDealId("1003"), "Gamma course", "Closed won"],
  ]);
  is("an amount when it could be read, none otherwise", deals.map((d) => d.cents), [150000, 0, 0]);
  is("the first person HubSpot associated, when there is one", deals.map((d) => d.email), ["ada@example.com", "", "grace@example.com"]);
  is("the Record ID and the close date in the note", deals.map((d) => d.note), [
    "From HubSpot, Record ID 1001.\nExpected to close on 2026-12-01 (from HubSpot).",
    "From HubSpot, Record ID 1002.",
    "From HubSpot, Record ID 1003.\nClosed on 2026-10-01 (from HubSpot).",
  ]);
  is("what a deal came in without is said, by row", (saved.body.summary?.notices as { line: number; note: string }[]).map((x) => x.line), [4, 4]);
  is("the amount in another currency is one of them", String(saved.body.summary?.notices?.[0]?.note).startsWith("This amount is in EUR and your store uses USD"), true);
  const after = await dataUsed(store);
  is("the data room is taken for what was written", (after?.used ?? 0) > (before?.used ?? 0), true);

  part("The same file twice adds nothing");
  const again = await call({ action: "save", ...first });
  is("every deal is already there", [again.status, again.body.summary?.added, again.body.summary?.alreadyThere, again.body.summary?.pipelinesCreated, again.body.summary?.stagesCreated], [200, 0, 3, [], []]);
  is("each deal already here is listed by row, with its name here", again.body.summary?.alreadyThereDeals, [
    { line: 2, title: "Acme retainer", here: "Acme retainer" },
    { line: 3, title: "Beta workshop", here: "Beta workshop" },
    { line: 4, title: "Gamma course", here: "Gamma course" },
  ]);
  is("no deal and no pipeline more", [await dealCount(statsId), (await readPipelines(statsId)).length], [3, 2]);
  is("and no more room", (await dataUsed(store))?.used, after?.used);

  part("What the store has is used, never renamed");
  const reuse = await call({
    action: "save",
    header: HEADER,
    currency: "usd",
    rows: [row("2001", "Delta call", "talking", "sales"), row("2002", "Epsilon pitch", "Proposal", "SALES"), row("2003", "Zeta deal", "Closed won", "Sales")],
  });
  is("the existing pipeline and stage are used, one stage made, won joined to the pipeline's own", [reuse.body.summary?.pipelinesCreated, reuse.body.summary?.stagesCreated, reuse.body.summary?.stagesJoined], [[], [{ pipeline: "Sales", stage: "Proposal" }], [{ pipeline: "Sales", from: "Closed won", to: "Won" }]]);
  const sales = (await readPipelines(statsId))[0];
  is("the new open stage goes after the open ones; names as they were", sales.stages.map((s) => s.name), ["New", "Talking", "Offer sent", "Proposal", "Won", "Lost"]);
  const salesDeals = (await readDeals(statsId, sales.stages)).filter((d) => sales.stages.some((s) => s.id === d.stage));
  is("each deal in its stage", salesDeals.map((d) => [d.title, sales.stages.find((s) => s.id === d.stage)?.name]).sort(), [["Delta call", "Talking"], ["Epsilon pitch", "Proposal"], ["Zeta deal", "Won"]]);

  part("The plan's pipelines and the stages a pipeline holds");
  is("this plan holds two pipelines", PIPELINES_BY_TIER.creator, 2);
  const past = await call({ action: "save", header: HEADER, currency: "usd", rows: [row("3001", "Partner deal", "New", "Partners"), row("3002", "Alpha", "Step A", "Sales"), row("3003", "Bravo", "Step B", "Sales"), row("3004", "Charlie", "Step C", "Sales")] });
  is("a pipeline past the plan's is refused with what to do", past.body.summary?.refused?.[0], { line: 2, column: "Pipeline", value: "Partners", reason: pipelineRoomReason(0) });
  is(`stages past ${MAX_STAGES} are refused; the ones that fit are made`, [past.body.summary?.stagesCreated, past.body.summary?.refused?.slice(1).map((r: { value: string; reason: string }) => [r.value, r.reason === STAGE_PAST_REASON])], [[{ pipeline: "Sales", stage: "Step A" }, { pipeline: "Sales", stage: "Step B" }], [["Step C", true]]]);
  is("no pipeline past the plan's is made", (await readPipelines(statsId)).map((p) => [p.name, p.stages.length]), [["Sales", MAX_STAGES], ["Sales Pipeline", 4]]);
  is("two deals added", [past.body.summary?.added, await dealCount(statsId)], [2, 8]);

  part("Not a HubSpot deals file, or a file that cannot be read");
  const contacts = await call({ action: "save", header: ["Record ID", "Email", "First name"], rows: [["1", "ada@example.com", "Ada"]] });
  is("a contacts file is not a deals file", [contacts.status, contacts.body.error, contacts.body.message], [400, "not_hubspot", HUBSPOT_IMPORT_WORDS.not_hubspot]);
  const other = await call({ action: "save", header: ["Nummer", "Name des Deals", "Phase"], rows: [["1", "x", "y"]] });
  is("a file with other labels is not one", other.body.error, "not_hubspot");
  const long = await call({ action: "save", header: HEADER, rows: [row("4001", "x".repeat(3_000), "New", "Sales")] });
  is("a cell too long refuses the file, never cut", [long.status, long.body.error, typeof long.body.message], [400, "rows", "string"]);
  is("and nothing was written", await dealCount(statsId), 8);

  part("A file past the store's deals is refused whole");
  const full = await paidStore("hubsfull");
  const fullId = full.store.statsId!;
  const filler: (string | number)[] = [];
  for (let i = 0; i < MAX_DEALS - 1; i += 1) {
    const id = "f" + String(i).padStart(9, "0");
    filler.push(id, JSON.stringify({ id, title: "Filler " + i, email: "", cents: 0, stage: "lead00", note: "", createdAt: 1, updatedAt: 1 }));
  }
  await redis.pipeline([["HSET", "nl:crm:deals:" + fullId, ...filler]]);
  const roomBefore = await dataUsed(full.store);
  const tooMany: HubSpotImportResult = await importHubSpotDeals(full.store, { header: HEADER, rows: [row("5001", "One", "New", "Sales"), row("5002", "Two", "New", "Sales")] }, { write: true });
  is("two new deals and room for one: refused", tooMany.ok ? "" : [tooMany.reason, tooMany.message.startsWith("This file has 2 deals to bring in, and your store has room for 1 deal more")], ["too_many", true]);
  is("nothing written, no room taken", [await dealCount(fullId), (await readPipelines(fullId)).length, (await dataUsed(full.store))?.used], [MAX_DEALS - 1, 1, roomBefore?.used]);
  const originalFull = redis.pipeline.bind(redis);
  let filled = false;
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (!filled && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) {
        filled = true;
        await originalFull([["HSET", "nl:crm:deals:" + fullId, "g000000001", JSON.stringify({ id: "g000000001", title: "From a form", email: "", cents: 0, stage: "lead00", note: "", createdAt: 1, updatedAt: 1 })]]);
      }
      return originalFull(commands);
    };
    const meanwhile = await call({ action: "save", header: HEADER, rows: [row("5003", "Last one", "New", "Sales")] }, full.session);
    is("a store that fills up meanwhile refuses the whole file, as a conflict (409), not a bad file", [meanwhile.status, meanwhile.body.error, /reached its 1,000 deals while this file was being brought in, so nothing was brought in/.test(meanwhile.body.message)], [409, "deals_full", true]);
  } finally { redis.pipeline = originalFull; }
  is("nothing of it written, its room given back", [await dealCount(fullId), (await readPipelines(fullId)).length, (await dataUsed(full.store))?.used], [MAX_DEALS, 1, roomBefore?.used]);

  part("A file past the month's rows is refused whole");
  const rows = await paidStore("hubsrows");
  const rowsId = rows.store.statsId!;
  is("this plan brings in this many rows a month", IMPORT_ALLOWANCES.creator.rows, 1_000);
  is("most of the month's rows already used", (await takeImportRows(rows.store, 980)).ok, true);
  const rowsRoom = await dataUsed(rows.store);
  const overRows = await call({ action: "save", header: HEADER, rows: [row("6001", "One", "New", "Leads"), row("6002", "Two", "New", "Leads")] }, rows.session);
  is("refused, with what to do", [overRows.status, overRows.body.error, overRows.body.limit, String(overRows.body.message).includes("Nothing was brought in")], [429, "rows_month", 1_000, true]);
  is("nothing written and the room given back", [await dealCount(rowsId), (await readPipelines(rowsId)).map((p) => p.name), (await dataUsed(rows.store))?.used], [0, ["Sales"], rowsRoom?.used]);

  part("A file past the store's data room is refused whole");
  const roomy = await paidStore("hubsroom");
  const roomyId = roomy.store.statsId!;
  const measure = await dataUsed(roomy.store);
  is("the room is filled to within a few bytes", (await takeData(roomy.store, [{ slot: "filler", bytes: contentRoomFor(roomy.store) - (measure?.used ?? 0) - 100, set: true }])).ok, true);
  const overRoom = await call({ action: "save", header: HEADER, rows: [row("7001", "One", "New", "Sales")] }, roomy.session);
  is("refused as a full store, with the room's own words", [overRoom.status, overRoom.body.error, typeof overRoom.body.message], [409, "store_full", "string"]);
  is("nothing written", await dealCount(roomyId), 0);
  // Sent again and again, a file that cannot fit costs one read of the room each time, never the room's work for
  // each of its deals (Claude 1 on #2048: that work ran before the refusal, and the month's rows went back).
  const bigFile = Array.from({ length: 60 }, (_, i) => row(String(7100 + i), `Deal ${i}`, "New", "Sales"));
  const roomRealPipeline = redis.pipeline.bind(redis);
  let slotWork = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) if (c[0] === "EVAL" && c[1] === TAKE_DATA) slotWork += (c.length - 7) / 3;
    return roomRealPipeline(commands);
  }) as typeof redis.pipeline;
  const resent: string[] = [];
  try {
    for (let i = 0; i < 3; i++) resent.push(String((await call({ action: "save", header: HEADER, rows: bigFile }, roomy.session)).body.error));
  } finally { redis.pipeline = roomRealPipeline; }
  is("a full store's file sent three times: refused each time, with no room work per deal", [resent, slotWork], [["store_full", "store_full", "store_full"], 0]);
  is("and still nothing written", await dealCount(roomyId), 0);

  part("One import at a time");
  const held = await takeCrmLock(statsId);
  const started = Date.now();
  const busy = await call({ action: "save", header: HEADER, rows: [row("8001", "Busy one", "New", "Sales")] });
  is("a second one waits, then is refused with what to do", [busy.status, busy.body.error, busy.body.message, Date.now() - started >= CRM_LOCK_WAIT_MS / 2], [409, "busy", HUBSPOT_IMPORT_WORDS.busy, true]);
  is("and writes nothing", await dealCount(statsId), 8);
  const dry2 = await call({ action: "check", header: HEADER, rows: [row("8001", "Busy one", "New", "Sales")] });
  is("a dry run takes no lock", [dry2.status, dry2.body.summary?.added], [200, 1]);
  setTimeout(() => void releaseLock(held), 300);
  const waited = await call({ action: "save", header: HEADER, rows: [row("8001", "Busy one", "New", "Sales")] });
  is("one that comes while the lock is let go waits its turn and is saved", [waited.status, waited.body.summary?.added], [200, 1]);

  const rowsKey = () => `nl:imports:rows:${store.sid}:${windowId(store, Date.now())}`;
  const rowsUsed = async () => Number((await redis.pipeline([["GET", rowsKey()]]))[0] ?? 0);

  part("Pipelines changed meanwhile are never overwritten");
  const original = redis.pipeline.bind(redis);
  const roomChanged = await dataUsed(store);
  const rowsChanged = await rowsUsed();
  let oldRecord = "", newRecord = "";
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) {
        oldRecord = String((await original([["GET", "nl:crm:pipes:" + statsId]]))[0]);
        const current = JSON.parse(oldRecord);
        current[1].name = "Renamed on the board";
        newRecord = JSON.stringify(current);
        await original([["SET", "nl:crm:pipes:" + statsId, newRecord]]);
        // The board's own save counts its room by what it changes, as a real save does.
        await noteData(store, [{ slot: "crm:pipes", bytes: dataBytes([newRecord], 1) - dataBytes([oldRecord], 1) }]);
      }
      return original(commands);
    };
    const changed = await call({ action: "save", header: HEADER, rows: [row("9001", "New pipeline deal", "Open", "Sales Pipeline")] });
    is("refused, with what to do", [changed.status, changed.body.error, changed.body.message], [409, "changed", HUBSPOT_IMPORT_WORDS.changed]);
  } finally { redis.pipeline = original; }
  is("the board's change stays, no deal added, the month's rows given back", [(await readPipelines(statsId)).map((p) => p.name), await dealCount(statsId), await rowsUsed()], [["Sales", "Renamed on the board"], 9, rowsChanged]);
  is("the pipelines are counted at the record as it is now, not as the import first read it", (await dataUsed(store))?.used, (roomChanged?.used ?? 0) - dataBytes([oldRecord], 1) + dataBytes([newRecord], 1));

  part("A deal here without its HubSpot note is never taken for the same one");
  const beta = (await readDeal(statsId, hubSpotDealId("1002"), allStages(await readPipelines(statsId))))!;
  is("the creator rewrote that deal's note on the board", await writeDeal(statsId, { ...beta, note: "Called them on Monday." }, store), true);
  const third = await call({ action: "save", ...first });
  is("its row is refused with what to do; the others are already here", [third.status, third.body.summary?.alreadyThere, third.body.summary?.refused?.map((r: { line: number; value: string }) => [r.line, r.value]), /does not say it came from that record/.test(third.body.summary?.refused?.[0]?.reason)], [200, 2, [[3, "1002"]], true]);
  is("and that deal is left as the creator made it", (await readDeal(statsId, beta.id, allStages(await readPipelines(statsId))))?.note, "Called them on Monday.");

  part("The board's change of pipelines waits for an import, never removes a stage under it");
  let boardTried: unknown = "not tried";
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (boardTried === "not tried" && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) {
        boardTried = null;
        const [salesNow] = await readPipelines(statsId);
        boardTried = await savePipelineChange(statsId, { pipeline: { ...salesNow, stages: salesNow.stages.filter((st) => st.name !== "Offer sent") } }, {}, 2, store).then(() => "saved", (error: unknown) => error);
      }
      return original(commands);
    };
    const during = await call({ action: "save", header: HEADER, rows: [row("9201", "Offer deal", "Offer sent", "Sales")] });
    is("the import is saved", [during.status, during.body.summary?.added], [200, 1]);
  } finally { redis.pipeline = original; }
  is("the board's change was refused while the import held the lock", boardTried instanceof LockBusyError, true);
  is("so the stage is still there, with the deal in it", [(await readPipelines(statsId))[0].stages.some((st) => st.name === "Offer sent"), await dealCount(statsId)], [true, 10]);
  is("and the opportunities review reads every deal", (await readOpportunityReview(statsId)).available, true);

  part("An import never lands deals in a stage the board is removing");
  const [salesBefore] = await readPipelines(statsId);
  const offer = salesBefore.stages.find((st) => st.name === "Offer sent")!;
  const talking = salesBefore.stages.find((st) => st.name === "Talking")!;
  const racing: { result: HubSpotImportResult | null } = { result: null };
  let raced = false;
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (!raced && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-pipelines-save"))) {
        raced = true;
        racing.result = await importHubSpotDeals(store, { header: HEADER, rows: [row("9251", "Racing deal", "Offer sent", "Sales")] }, { write: true });
      }
      return original(commands);
    };
    await savePipelineChange(statsId, { pipeline: { ...salesBefore, stages: salesBefore.stages.filter((st) => st.id !== offer.id) } }, { [offer.id]: talking.id }, 2, store);
  } finally { redis.pipeline = original; }
  is("an import that comes while the board saves waits, then is refused", [raced, racing.result && !racing.result.ok && racing.result.reason], [true, "busy"]);
  const afterRace = await readPipelines(statsId);
  is("the stage is gone, its deal moved where the board said, no deal left without a stage", [afterRace[0].stages.some((st) => st.id === offer.id), (await readDeal(statsId, hubSpotDealId("9201"), allStages(afterRace)))?.stage, await dealCount(statsId)], [false, talking.id, 10]);
  is("so the opportunities review still reads every deal", (await readOpportunityReview(statsId)).available, true);

  part("The board's pipelines change is refused while an import runs, with what to do");
  const crmCall = async (body: Record<string, unknown>) => {
    const response = await CRM_POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const importing = await takeCrmLock(statsId);
  try {
    const waiting = await crmCall({ action: "pipeline", pipeline: afterRace[0], moves: {} });
    is("a conflict (409) the board reads as such", [waiting.status, waiting.body.error, crmAnswer(false, waiting.body)], [409, "crm_busy", { ok: false, error: "crm_busy" }]);
    const stagesWaiting = await crmCall({ action: "stages", stages: afterRace[0].stages });
    is("the older stages request too", [stagesWaiting.status, stagesWaiting.body.error], [409, "crm_busy"]);
  } finally { await releaseLock(importing); }
  is("nothing changed", (await readPipelines(statsId)).map((p) => p.stages.length), afterRace.map((p) => p.stages.length));

  part("A save that cannot be confirmed keeps the month's rows, as it keeps the room");
  const rowsUnsure = await rowsUsed();
  const roomUnsure = await dataUsed(store);
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) throw new Error("reply lost");
      return original(commands);
    };
    const unsure = await call({ action: "save", header: HEADER, rows: [row("9281", "Unsure deal", "New", "Sales"), row("9282", "Unsure two", "New", "Sales")] });
    is("said as unconfirmed", [unsure.status, unsure.body.error], [502, "unconfirmed"]);
  } finally { redis.pipeline = original; }
  is("the rows stay counted and the room stays taken: the write may have happened", [await rowsUsed() > rowsUnsure, ((await dataUsed(store))?.used ?? 0) > (roomUnsure?.used ?? 0)], [true, true]);

  part("A lock that cannot be confirmed before the write sends nothing, and gives back the room and the rows");
  const isExtend = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).includes('"EXPIRE"') && String(c[3]).startsWith("nl:crm:lock:");
  for (const [label, failing] of [["the database does not answer", "throw"], ["the lock ran out", "lost"]] as const) {
    const rowsLock = await rowsUsed();
    const roomLock = await dataUsed(store);
    let sent = false, extended = false;
    try {
      redis.pipeline = async (commands: (string | number)[][]) => {
        if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) sent = true;
        if (commands.some(isExtend)) {
          if (failing === "lost") return [0];
          extended = true;
          throw new Error("network down");
        }
        // holdLock's own fallback read fails too; letting go of the lock after works again.
        if (extended && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:crm:lock:"))) {
          extended = false;
          throw new Error("network down");
        }
        return original(commands);
      };
      const lost = await call({ action: "save", header: HEADER, rows: [row("9291", "Lock deal", "New", "Sales")] });
      is(`${label}: said as not saved, to try again`, [lost.status, lost.body.error, lost.body.message], [503, "lock_lost", HUBSPOT_IMPORT_WORDS.lock_lost]);
    } finally { redis.pipeline = original; }
    is(`${label}: the import was never sent, and the room and the month's rows went back`, [sent, await rowsUsed(), (await dataUsed(store))?.used, await dealCount(statsId)], [false, rowsLock, roomLock?.used, 10]);
  }
  const rowsRefused = await rowsUsed();
  let refusedSent = false;
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) {
        refusedSent = true;
        const raw = String((await original([["GET", "nl:crm:pipes:" + statsId]]))[0]);
        await original([["SET", "nl:crm:pipes:" + statsId, JSON.stringify(JSON.parse(raw), null, 1)]]);
      } else if (refusedSent && commands.some((c) => c[0] === "EVAL" && String(c[3]).startsWith("nl:data:"))) throw new Error("network down");
      return original(commands);
    };
    const refusedRoom = await call({ action: "save", header: HEADER, rows: [row("9295", "Refused deal", "New", "Sales")] });
    is("a refused step whose room cannot be put right is still said as refused", [refusedSent, refusedRoom.status, refusedRoom.body.error], [true, 409, "changed"]);
  } finally { redis.pipeline = original; }
  is("and the month's rows still come back", await rowsUsed(), rowsRefused);

  part("Busy is said without naming who holds the lock; a lost lock on the board is not busy");
  const boardHolds = await takeCrmLock(statsId);
  try {
    const waitingImport = await call({ action: "save", header: HEADER, rows: [row("9296", "Waiting deal", "New", "Sales")] });
    is("an import while the board changes pipelines is not told another file is coming in", [waitingImport.status, waitingImport.body.error, /deals or pipelines are being changed/.test(waitingImport.body.message), /file of deals/.test(waitingImport.body.message)], [409, "busy", true, false]);
  } finally { await releaseLock(boardHolds); }
  try {
    redis.pipeline = async (commands: (string | number)[][]) => (commands.some(isExtend) ? [0] : original(commands));
    const lostBoard = await crmCall({ action: "pipeline", pipeline: (await readPipelines(statsId))[0], moves: {} });
    is("the board's change whose lock ran out is not saved, and says so, not busy", [lostBoard.status, lostBoard.body.error, crmAnswer(false, lostBoard.body)], [503, "crm_not_saved", { ok: false, error: "crm_not_saved" }]);
  } finally { redis.pipeline = original; }

  part("A deal is never overwritten");
  const foreign = JSON.stringify({ id: hubSpotDealId("9301"), title: "Made meanwhile", email: "", cents: 0, stage: "lead00", note: "", createdAt: 1, updatedAt: 1 });
  let planted = false;
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (!planted && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import"))) {
        planted = true;
        await original([["HSET", "nl:crm:deals:" + statsId, hubSpotDealId("9301"), foreign]]);
        // The deal made meanwhile counts its own room, as a real save does.
        await noteData(store, [{ slot: "dl:" + hubSpotDealId("9301"), bytes: dataBytes([hubSpotDealId("9301"), foreign], 1) }]);
      }
      return original(commands);
    };
    const clash = await call({ action: "save", header: HEADER, rows: [row("9301", "From the file", "New", "Sales"), row("9302", "Another", "New", "Sales")] });
    is("a deal that took the id meanwhile refuses the whole file", [clash.status, clash.body.error], [409, "changed"]);
  } finally { redis.pipeline = original; }
  is("the deal there is kept as it was, and the other is not added", [String((await redis.pipeline([["HGET", "nl:crm:deals:" + statsId, hubSpotDealId("9301")]]))[0]), await dealCount(statsId)], [foreign, 11]);
  const slotOf = async (id: string) => Number((await redis.pipeline([["HGET", String(dataKey(store)), "dl:" + id]]))[0] ?? 0);
  is("the deal there is counted at its own weight, never emptied; the other's room goes back", [await slotOf(hubSpotDealId("9301")), await slotOf(hubSpotDealId("9302"))], [dataBytes([hubSpotDealId("9301"), foreign], 1), 0]);

  part("Rows refused or already here never take a pipeline's place");
  const slot = await paidStore("hubsslot");
  const slotId = slot.store.statsId!;
  const [board] = await readPipelines(slotId);
  await savePipelineChange(slotId, { pipeline: { ...board, name: "Main board" } }, {}, 2, slot.store);
  const loose = await importHubSpotDeals(slot.store, { header: HEADER, rows: [row("1", "Loose deal", "New", "")] }, { write: true });
  is("a deal with no pipeline goes to the store's first pipeline, whatever its name", [loose.ok && loose.summary.pipelinesCreated, (await readPipelines(slotId)).map((p) => p.name)], [[], ["Main board"]]);
  const p1 = await importHubSpotDeals(slot.store, { header: HEADER, rows: [row("11", "First deal", "Pitch", "P1")] }, { write: true });
  is("a second pipeline is made: the plan's two are used", [p1.ok && p1.summary.added, (await readPipelines(slotId)).map((p) => p.name)], [1, ["Main board", "P1"]]);
  const p1Id = (await readPipelines(slotId))[1].id;
  await savePipelineChange(slotId, { remove: p1Id }, "lead00", 2, slot.store);
  const later = await importHubSpotDeals(slot.store, { header: HEADER, rows: [row("11", "First deal", "Pitch", "P1"), row("", "No id", "Pitch", "P1"), row("12", "Second deal", "Pitch", "P2")] }, { write: true });
  is("the pipeline of a deal already here is not made again, so the new one fits", [later.ok && later.summary.pipelinesCreated.map((p) => p.name), later.ok && later.summary.alreadyThere, later.ok && later.summary.added, later.ok && later.summary.refused.map((r) => r.column)], [["P2"], 1, 1, ["Record ID"]]);
  is("the store has its two pipelines", (await readPipelines(slotId)).map((p) => p.name), ["Main board", "P2"]);
  const closedOnly = await importHubSpotDeals(slot.store, { header: HEADER, rows: [row("13", "Old win", "Closed won", "P3")] }, { write: false });
  is("a dry run past the plan's pipelines refuses that pipeline's deals", closedOnly.ok && closedOnly.summary.refused.map((r) => r.column), ["Pipeline"]);

  const eleven = await importHubSpotDeals(slot.store, { header: HEADER, rows: Array.from({ length: 11 }, (_, i) => row(String(100 + i), `Deal ${i}`, "Pitch", `Line ${i}`)) }, { write: false });
  is("every row of a pipeline past the store's room says the store's own room, never more", eleven.ok && [...new Set(eleven.summary.refused.map((r) => r.reason))], [pipelineRoomReason(0)]);

  part("Rows refused for a pipeline never count against the store's deals");
  const wide = await paidStore("hubswide");
  const wideRows = [...Array.from({ length: 600 }, (_, i) => row(String(20_000 + i), `One ${i}`, "Pitch", "P1")), ...Array.from({ length: 600 }, (_, i) => row(String(30_000 + i), `Two ${i}`, "Pitch", "P2"))];
  const twoPipelines = await importHubSpotDeals(wide.store, { header: HEADER, rows: wideRows }, { write: false });
  is("two pipelines of 600 on a plan with room for one more: the 600 that fit come in, the others are refused by row", twoPipelines.ok && [twoPipelines.summary.added, twoPipelines.summary.refused.length, twoPipelines.summary.pipelinesCreated.map((p) => p.name)], [600, 600, ["P1"]]);

  part("What the file says, read strictly");
  const noId = await call({ action: "save", header: ["Deal name", "Deal stage", "Pipeline"], rows: [["One", "New", "Sales"]] });
  is("a deals file with no Record ID column says to export with all properties", [noId.status, noId.body.error, noId.body.message], [400, "no_record_id", HUBSPOT_IMPORT_WORDS.no_record_id]);
  const coin = await call({ action: "check", header: HEADER, currency: "USDC", rows: [row("9401", "Coin deal", "New", "Sales", "1500")] });
  is("a currency that is not a three-letter code is taken as not said, never cut to one", [coin.status, /does not say which currency/.test(coin.body.summary?.notices?.[0]?.note)], [200, true]);

  part("Who may bring deals in");
  await putMember(store, "helper@example.com", "support");
  await putMember(store, "editor@example.com", "editor");
  const support = await call({ action: "check", ...first }, await openSession("helper@example.com"), store.sid);
  const editor = await call({ action: "save", ...first }, await openSession("editor@example.com"), store.sid);
  is("support and editors may not import", [support.status, editor.status], [403, 403]);
  const nobody = await call({ action: "save", ...first }, "");
  is("no session is refused", [nobody.status, nobody.body.error], [401, "signed_out"]);
  is("nothing written by any of them", await dealCount(statsId), 11);

  part("Codex J on #2048: a pipeline write is fenced by its lock in the same step, even after the lock ran out");
  const leaseStore = await paidStore("jhublease");
  const leaseId = leaseStore.store.statsId!;
  await importHubSpotDeals(leaseStore.store, {header:HEADER, rows:[row("jold", "Old deal", "Offer sent", "Sales")]}, {write:true});
  const [leasePipe] = await readPipelines(leaseId);
  const leaseOffer = leasePipe.stages.find(s=>s.name==="Offer sent")!;
  const leaseTalk = leasePipe.stages.find(s=>s.name==="Talking")!;
  let leaseRaced=false;
  let leaseImported:HubSpotImportResult|null=null;
  try{
    redis.pipeline=async commands=>{
      if(!leaseRaced && commands.some(c=>c[0]==="EVAL" && String(c[1]).includes("crm-pipelines-save"))){
        leaseRaced=true;
        redis.advance(61_000);
        leaseImported=await importHubSpotDeals(leaseStore.store,{header:HEADER, rows:[row("jnew", "Fresh deal", "Offer sent", "Sales")]},{write:true});
      }
      return original(commands);
    };
    await savePipelineChange(leaseId,{pipeline:{...leasePipe,stages:leasePipe.stages.filter(s=>s.id!==leaseOffer.id)}},{[leaseOffer.id]:leaseTalk.id},2,leaseStore.store).catch(error=>console.log("Old writer refused",error.name));
  }finally{redis.pipeline=original;}
  const leasePipes=await readPipelines(leaseId);
  const leaseRaw=(await redis.pipeline([["HGET", "nl:crm:deals:"+leaseId,hubSpotDealId("jnew")]]))[0];
  console.log("Codex J lease reproduction",JSON.stringify({raced:leaseRaced,imported:leaseImported,pipelines:leasePipes,raw:leaseRaw}));
  is("lease race was exercised and no newly imported deal is orphaned",[leaseRaced,(await readOpportunityReview(leaseId)).available],[true,true]);


  part("Codex J on #2048: a file refused for the month does no per-deal room work");
  const exhausted = await paidStore("jhubcost");
  await takeImportRows(exhausted.store,IMPORT_ALLOWANCES.creator.rows);
  const observed:(string|number)[][]=[];
  let refusedCost:{status:number;body:{error?:string}};
  try{
    redis.pipeline=async commands=>{observed.push(...commands.map(c=>[...c]));return original(commands);};
    refusedCost=await call({action:"save",header:HEADER,currency:"usd",rows:Array.from({length:1000},(_,i)=>row(String(i+1),"Deal "+i,"New","Sales"))},exhausted.session);
  }finally{redis.pipeline=original;}
  const slotCounts=observed.filter(c=>c[0]==="EVAL" && String(c[1]).includes("marktmorgen:store-data:v1")).map(c=>(c.length-7)/3);
  const billedLowerBound=observed.length+slotCounts.reduce((n,slots)=>n+3+2*slots,0);
  const exhaustedRows=(await original([["GET",`nl:imports:rows:${exhausted.store.sid}:${windowId(exhausted.store,Date.now())}`]]))[0];
  console.log("Codex J exhausted quota reproduction",JSON.stringify({status:refusedCost.status,error:refusedCost.body.error,wire:observed.length,slotCounts,billedLowerBound,rows:exhaustedRows}));
  is("refused file consumes no per-deal data-room writes after rows were already exhausted",[refusedCost.status,slotCounts.every(n=>n===0)],[429,true]);


  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
