/**
 * What a workflow's history costs the studio (Claude 5's second review of
 * #1927, MEDIUM; the coordinator's decision B). Through the studio's real
 * mail route, with the real saveFlow and Redis in memory, a workflow of five
 * steps of 10,000 characters with ten versions kept:
 *
 *   - a version is kept at most once a pause of edits: an autosave inside the
 *     pause reads and writes no version, and moves no more than reading the
 *     workflows once and writing them once (what a save moved before versions
 *     were kept), for the request's own studio unit only;
 *   - listing the versions, putting one back and the save that keeps a version
 *     take studio units for the bytes they move, measured before any of it is
 *     read, at 50,000 bytes a unit (UNIT_COST.studio), on top of the request's
 *     own;
 *   - without those units, nothing of the history is read.
 *
 * Bytes are counted as Redis keeps them: every string sent in a command and
 * every string answered, on the workflows' and the versions' keys.
 */
import { NextRequest } from "next/server";
import { readFlows, saveFlow } from "@/lib/flows";
import { readFlowVersions } from "@/lib/flow-versions";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "history-cost@example.com";
/** The fifty kilobytes a studio request pays to move (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_BYTES = 50_000;
/** Past one pause of edits (lib/flow-versions-rules.ts, FLOW_VERSION_PAUSE_SECONDS, ten minutes). */
const PAST_PAUSE_MS = 601_000;

type Seen = { command: (string | number)[]; bytes: number };

const bytesOf = (value: unknown): number =>
  typeof value === "string" ? Buffer.byteLength(value, "utf8") : typeof value === "number" ? String(value).length : Array.isArray(value) ? value.reduce((sum: number, v) => sum + bytesOf(v), 0) : 0;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "historycost", "History Cost Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHist00001", true);
  await setSubscription(OWNER, { customerId: "cus_Hist0001", subscriptionId: "sub_Hist0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "History Cost Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = async () => (await storeForEmail(OWNER))!;
  const list = (await store()).listId as string;
  const session = await openSession(OWNER);
  const flowsKey = `nl:mail:flows:${list}`;

  // Every command and answer, while recording.
  const base = redis.pipeline.bind(redis);
  let seen: Seen[] = [];
  redis.pipeline = async (commands) => {
    const replies = await base(commands);
    commands.forEach((command, i) => seen.push({ command, bytes: bytesOf(command) + bytesOf(replies[i]) }));
    return replies;
  };
  const post = async (body: Record<string, unknown>) => {
    const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok?: boolean; error?: string; message?: string; versions?: { at: number }[] } };
  };
  const big = (n: number) => ({ name: "Welcome", trigger: "joined", steps: Array.from({ length: 5 }, (_, i) => ({ delayHours: i * 24, subject: `Day ${i + 1}`, body: `${n} `.padEnd(10_000, String.fromCharCode(97 + ((n + i) % 26))) })) });

  const first = await saveFlow(await store(), big(0));
  if (!first.ok) throw new Error(`no workflow: ${first.reason}`);
  const id = first.flows[0].id;
  const versionsKey = `nl:wf:ver:${list}:${id}`;
  // A command that reads or writes the workflow's versions themselves (never the mark of a pause).
  const onVersions = (command: (string | number)[]) => command.some((arg) => arg === versionsKey);
  const onHistory = (command: (string | number)[]) => command.some((arg) => arg === versionsKey || arg === flowsKey);
  const historyBytes = () => seen.filter((s) => onHistory(s.command)).reduce((sum, s) => sum + s.bytes, 0);
  const studioTakes = (seen: Seen[], until: number) => seen.slice(0, until).filter((s) => s.command[0] === "INCRBY" && String(s.command[1]).startsWith("nl:allow:studio:")).length;
  const firstIndex = (seen: Seen[], test: (command: (string | number)[]) => boolean) => seen.findIndex((s) => test(s.command));
  // Measuring their lengths in Redis (lib/flow-versions.ts, FLOW_HISTORY_SIZE) answers three numbers and reads none of
  // their text out; its bytes still count in what a request moves (historyBytes).
  const measuring = (command: (string | number)[]) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:flow-history-size:");
  const readsFlows = (command: (string | number)[]) => (command[0] === "GET" || command[0] === "EVAL") && command.includes(flowsKey) && !measuring(command);
  const readsVersions = (command: (string | number)[]) => onVersions(command) && (command[0] === "LRANGE" || command[0] === "EVAL") && !measuring(command);
  for (let n = 1; n <= 10; n += 1) {
    advance(PAST_PAUSE_MS);
    await saveFlow(await store(), { id, ...big(n) });
  }
  is("(ten versions of five steps of 10,000 characters kept)", (await readFlowVersions(list, id)).length, 10);
  const flowsBytes = Buffer.byteLength((redis.run(["GET", flowsKey]) as string) ?? "", "utf8");

  const measured = async (label: string, body: Record<string, unknown>) => {
    const before = await allowanceUsed(await store(), "studio");
    seen = [];
    const answer = await post(body);
    const units = (await allowanceUsed(await store(), "studio")) - before;
    const bytes = historyBytes();
    // What the request itself moved on the versions, before this test reads them again to check them.
    const versionBytes = seen.filter((s) => onVersions(s.command)).reduce((sum, s) => sum + s.bytes, 0);
    const request = seen;
    seen = [];
    console.log(`  ${label}: ${bytes} bytes on the workflows and versions, ${units} studio units`);
    return { answer, units, bytes, versionBytes, request };
  };

  part("The save that keeps a version pays for what it moves, before it reads the versions");
  advance(PAST_PAUSE_MS);
  const keeping = await measured("keeping save", { action: "flow", flow: { id, ...big(11) } });
  is("saved", keeping.answer.data.ok, true);
  is("a version is kept for the pause", (await readFlowVersions(list, id))[0].flow.steps[0].body.startsWith("10 "), true);
  is("the units past the request's own cover the versions' bytes", (keeping.units - 1) * UNIT_BYTES >= keeping.versionBytes, true);
  is("they are taken before the versions are read", studioTakes(keeping.request, firstIndex(keeping.request, readsVersions)), 2);

  part("An autosave inside the pause reads and writes no version, and moves what a save moved before");
  const versionsBefore = (await readFlowVersions(list, id)).map((v) => v.at);
  const auto = await measured("autosave", { action: "flow", flow: { id, ...big(12) } });
  is("saved", [auto.answer.data.ok, (await readFlows(list)).find((f) => f.id === id)!.steps[0].body.startsWith("12 ")], [true, true]);
  is("no command reads or writes the versions", auto.request.filter((s) => onVersions(s.command)).map((s) => s.command[0]), []);
  is("the versions are as they were", (await readFlowVersions(list, id)).map((v) => v.at), versionsBefore);
  is("only the request's own studio unit", auto.units, 1);
  is("no more than the workflows read once and written once", auto.bytes <= 2 * flowsBytes + 4_096, true);

  part("A save past the pause keeps the next version");
  advance(PAST_PAUSE_MS);
  await post({ action: "flow", flow: { id, ...big(13) } });
  is("the version before it is the newest kept", (await readFlowVersions(list, id))[0].flow.steps[0].body.startsWith("12 "), true);

  part("Listing the versions pays for what it moves, before reading");
  const listing = await measured("listing", { action: "flow-versions", id });
  is("listed", [listing.answer.status, listing.answer.data.versions?.length], [200, 10]);
  is("the units past the request's own cover its bytes", (listing.units - 1) * UNIT_BYTES >= listing.bytes, true);
  is("taken before the workflows or the versions are read", studioTakes(listing.request, Math.min(...[firstIndex(listing.request, readsFlows), firstIndex(listing.request, readsVersions)].filter((i) => i >= 0))), 2);

  part("Putting one back pays for what it moves, before reading");
  const oldest = (await readFlowVersions(list, id)).at(-1)!;
  const restoring = await measured("restore", { action: "flow-restore", id, at: oldest.at });
  is("put back", [restoring.answer.status, restoring.answer.data.ok], [200, true]);
  is("the units past the request's own cover its bytes", (restoring.units - 1) * UNIT_BYTES >= restoring.bytes, true);
  is("taken before the workflows or the versions are read", studioTakes(restoring.request, Math.min(...[firstIndex(restoring.request, readsFlows), firstIndex(restoring.request, readsVersions)].filter((i) => i >= 0))), 2);

  part("Without the units, nothing of the history is read");
  const left = await takeAllowance(await store(), "studio", 1);
  if (left.ok && left.left > 1) await takeAllowance(await store(), "studio", left.left - 1);
  // One studio request left: the request's own, never what its history moves.
  await giveAllowance(await store(), "studio", 1);
  seen = [];
  const refused = await post({ action: "flow-versions", id });
  is("listing is refused with the studio's words", [refused.status, refused.data.error, Boolean(refused.data.message)], [429, "studio_used", true]);
  is("and reads neither the workflows nor the versions", seen.filter((s) => readsFlows(s.command) || readsVersions(s.command)).length, 0);
  await giveAllowance(await store(), "studio", 1);
  const kept = (await readFlowVersions(list, id)).at(-1)!;
  seen = [];
  const refusedRestore = await post({ action: "flow-restore", id, at: kept.at });
  is("putting back is refused with the studio's words", [refusedRestore.status, refusedRestore.data.error], [429, "studio_used"]);
  is("and reads neither", seen.filter((s) => readsFlows(s.command) || readsVersions(s.command)).length, 0);
  await giveAllowance(await store(), "studio", 1);
  advance(PAST_PAUSE_MS);
  const versionsHeld = (await readFlowVersions(list, id)).map((v) => v.at);
  seen = [];
  const unpaidSave = await post({ action: "flow", flow: { id, ...big(14) } });
  is("a save without them is still saved", [unpaidSave.status, unpaidSave.data.ok], [200, true]);
  is("but keeps no version, and reads none", [seen.filter((s) => readsVersions(s.command)).length, (await readFlowVersions(list, id)).map((v) => v.at)], [0, versionsHeld]);

  redis.pipeline = base;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
