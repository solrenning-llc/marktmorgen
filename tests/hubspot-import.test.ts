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
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CRM_LOCK_WAIT_MS, dealCount, readDeals, readPipelines, takeCrmLock } from "@/lib/crm";
import { MAX_DEALS, MAX_STAGES, PIPELINES_BY_TIER, allStages } from "@/lib/crm-rules";
import { STAGE_PAST_REASON, pipelineRoomReason } from "@/lib/hubspot-csv";
import { HUBSPOT_IMPORT_WORDS, type HubSpotImportResult, hubSpotDealId, hubSpotDealNote, importHubSpotDeals } from "@/lib/hubspot-import";
import { takeImportRows } from "@/lib/imports";
import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { releaseLock } from "@/lib/redis-lock";
import { claimHandle, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { dataUsed, takeData } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
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

async function main(): Promise<void> {
  redis.clear();
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

  part("Pipelines changed meanwhile are never overwritten");
  const original = redis.pipeline.bind(redis);
  const roomChanged = await dataUsed(store);
  try {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-pipelines-save"))) {
        const current = JSON.parse(String((await original([["GET", "nl:crm:pipes:" + statsId]]))[0]));
        current[1].name = "Renamed on the board";
        await original([["SET", "nl:crm:pipes:" + statsId, JSON.stringify(current)]]);
      }
      return original(commands);
    };
    const changed = await call({ action: "save", header: HEADER, rows: [row("9001", "New pipeline deal", "Open", "Sales Pipeline")] });
    is("refused, with what to do", [changed.status, changed.body.error, changed.body.message], [409, "changed", HUBSPOT_IMPORT_WORDS.changed]);
  } finally { redis.pipeline = original; }
  is("the board's change stays, no deal added, the room given back", [(await readPipelines(statsId)).map((p) => p.name), await dealCount(statsId), (await dataUsed(store))?.used], [["Sales", "Renamed on the board"], 9, roomChanged?.used]);

  part("Who may bring deals in");
  await putMember(store, "helper@example.com", "support");
  await putMember(store, "editor@example.com", "editor");
  const support = await call({ action: "check", ...first }, await openSession("helper@example.com"), store.sid);
  const editor = await call({ action: "save", ...first }, await openSession("editor@example.com"), store.sid);
  is("support and editors may not import", [support.status, editor.status], [403, 403]);
  const nobody = await call({ action: "save", ...first }, "");
  is("no session is refused", [nobody.status, nobody.body.error], [401, "signed_out"]);
  is("nothing written by any of them", await dealCount(statsId), 9);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
