/**
 * Moving a ClickFunnels funnel (lib/clickfunnels-funnel.ts, app/api/store/import/funnel/route.ts): the run ledger
 * (nl:imports:cf:<sid>) is what makes the same import pressed again make nothing twice. Its HMGET is read only in
 * its exact shape (lib/redis-reply.ts, CX-123 rule 24): one reply for the one command, a list of exactly one slot per
 * field asked, each slot a string or nil. Anything else is unknown, never "never made": the plan and the save throw
 * UnknownReplyError, the route answers 503 "unavailable", and nothing is made (sweep APP2 finding 5). Synthetic only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as funnelPost } from "@/app/api/store/import/funnel/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { convertSavedPage, trimSavedPage } from "@/lib/clickfunnels-page";
import { planFunnelImport, saveFunnelImport } from "@/lib/clickfunnels-funnel";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readForms } from "@/lib/form-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "cf-ledger-unknown@example.com";
let cookie = "";

function post(body: Record<string, unknown>) {
  return funnelPost(new NextRequest("https://marktmorgen.com/api/store/import/funnel", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: JSON.stringify(body) }));
}
const answer = async (res: Response) => [res.status, ((await res.clone().json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function counts() {
  const store = (await storeForEmail(OWNER))!;
  return [store.sitePages.length, (await readPageFunnels(store.statsId)).length, (await readForms(store.statsId)).length];
}

/** Runs `run` with the ledger's HMGET answered by `reply` (the whole pipeline answer), every other command as it is. */
async function withLedgerReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "HMGET" && String(commands[0][1]).startsWith("nl:imports:cf:")) return typeof reply === "function" ? (reply as (c: (string | number)[][]) => unknown)(commands) : reply;
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const thrown = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "cfledger", "Ledger Kitchen", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CfLedger0001", subscriptionId: "sub_CfLedger0001", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const optin = convertSavedPage(trimSavedPage(`<html><head><title>Free plan</title></head><body><h1>Get the free plan</h1><p>Seven days.</p><form><input name="first_name" placeholder="First name"><input type="email" placeholder="Email"><button>Send it</button></form></body></html>`), "optin.html");
  const thanks = convertSavedPage(trimSavedPage(`<html><body><h1>You're in</h1><p>Check your email.</p></body></html>`), "thanks.html");
  const pages = [
    { file: "optin.html", role: "page", product: "", bumps: [], draft: optin },
    { file: "thanks.html", role: "page", product: "", bumps: [], draft: thanks },
  ];
  const input = { name: "Free plan funnel", pages };

  part("Exact replies: the same import saved again makes nothing twice");
  is("first save", await answer(await post({ action: "save", ...input })), [200, "ok"]);
  is("two pages, one funnel, one form", await counts(), [2, 1, 1]);
  const again = await post({ action: "save", ...input });
  is("saved again: answers with what the first made", ((await again.json()) as { again?: boolean }).again, true);
  is("and nothing is made twice", await counts(), [2, 1, 1]);

  part("A ledger read in an unknown shape is unknown, never 'never made'");
  const holed: (string | null)[] = [null, null, null];
  delete holed[1];
  const shapes: [string, unknown][] = [
    ["an object instead of a list", [{ 0: "x" }]],
    ["no reply at all for the one command", []],
    ["two replies for one command", [[null, null, null], [null]]],
    ["a list one slot short", [[null, null]]],
    ["a list one slot long", [[null, null, null, null]]],
    ["a number in a slot", [[1, null, null]]],
    ["a hole in the list", [holed]],
    ["not a list of replies", { 0: [null, null, null] }],
  ];
  const store = (await storeForEmail(OWNER))!;
  for (const [what, reply] of shapes) {
    is(`plan: ${what} throws UnknownReplyError`, await withLedgerReply(reply, () => thrown(() => planFunnelImport(store, input))), "UnknownReplyError");
    is(`save: ${what} throws UnknownReplyError`, await withLedgerReply(reply, () => thrown(async () => saveFunnelImport((await storeForEmail(OWNER))!, input))), "UnknownReplyError");
  }
  is("nothing was made by any of them", await counts(), [2, 1, 1]);

  part("The route answers 503 'unavailable' and makes nothing");
  is("save of the import already done", await withLedgerReply([{ 0: "x" }], async () => answer(await post({ action: "save", ...input }))), [503, "unavailable"]);
  is("plan of it", await withLedgerReply([{ 0: "x" }], async () => answer(await post({ action: "plan", ...input }))), [503, "unavailable"]);
  const other = { name: "Thanks only", pages: [pages[1]] };
  // Thanks only asks two fields (its run, its one page): one slot is one short.
  is("save of a new import", await withLedgerReply([[null]], async () => answer(await post({ action: "save", ...other }))), [503, "unavailable"]);
  is("still two pages, one funnel, one form", await counts(), [2, 1, 1]);

  part("Exact nils still read as not made yet, and the lock was let go");
  is("the new import saves when the ledger answers in its shape", await answer(await post({ action: "save", ...other })), [200, "ok"]);
  is("its funnel is made, its page used again (the same page as before)", await counts(), [2, 2, 1]);

  // Review of #2974 (MEDIUM): an exact-shape reply whose `run:` entry is not one of the three shapes this file writes
  // ("started"; "funnel" with the funnel's id; "done" with what was made) is unknown too, never "never made": before,
  // each of these made one more funnel in the store on every press.
  part("A run entry in a shape this file never writes is unknown, never 'never made'");
  const exactPipeline = redis.pipeline.bind(redis);
  const runAs = (entry: string) => async (commands: (string | number)[][]) => {
    const replies = (await exactPipeline(commands)) as unknown[];
    const slots = [...(replies[0] as (string | null)[])];
    slots[0] = entry;
    return [slots];
  };
  const savedRun = ((await exactPipeline([["HGET", `nl:imports:cf:${(await storeForEmail(OWNER))!.sid}`, `run:${(await planFunnelImport((await storeForEmail(OWNER))!, input)).key}`]])) as unknown[])[0] as string;
  is("control: the first import's run entry is the exact 'done' shape", (JSON.parse(savedRun) as { state?: string }).state, "done");
  const doneEntry = JSON.parse(savedRun) as Record<string, unknown>;
  // The route's own save windows (10 a day, the plan's month) are not what this part checks: each route call starts
  // with them unused, so a 429 can never stand in for the 503.
  const freshSaveWindows = () => redis.pipeline(redis.keys().filter((k) => /^nl:rlm?:import-cf-save/.test(k)).map((k) => ["DEL", k]));
  const runShapes: [string, string][] = [
    ["not JSON", "not json"],
    ["JSON null", "null"],
    ["a list", "[]"],
    ["an unknown state", JSON.stringify({ state: "weird", at: 1 })],
    ["no state", JSON.stringify({ at: 1 })],
    ["'done' with an empty funnel", JSON.stringify({ state: "done", funnel: {} })],
    ["'done' with a funnel id that is not a string", JSON.stringify({ ...doneEntry, funnel: { ...(doneEntry.funnel as object), id: 7 } })],
    ["'done' without its pages", JSON.stringify({ ...doneEntry, pages: undefined })],
    ["'done' with a page id that is not a string", JSON.stringify({ ...doneEntry, pages: [1] })],
    ["'done' with counts that are not numbers", JSON.stringify({ ...doneEntry, bumps: "0" })],
    ["'funnel' without the funnel's id", JSON.stringify({ state: "funnel", at: 1 })],
    ["'funnel' with an id that is not a string", JSON.stringify({ state: "funnel", funnel: 7, at: 1 })],
    ["'funnel' with an empty id", JSON.stringify({ state: "funnel", funnel: "", at: 1 })],
    ["'started' without its time", JSON.stringify({ state: "started" })],
  ];
  for (const [what, entry] of runShapes) {
    is(`plan: ${what} throws UnknownReplyError`, await withLedgerReply(runAs(entry), () => thrown(async () => planFunnelImport((await storeForEmail(OWNER))!, input))), "UnknownReplyError");
    is(`save: ${what} throws UnknownReplyError`, await withLedgerReply(runAs(entry), () => thrown(async () => saveFunnelImport((await storeForEmail(OWNER))!, input))), "UnknownReplyError");
    await freshSaveWindows();
    is(`route save: ${what} answers 503 'unavailable'`, await withLedgerReply(runAs(entry), async () => answer(await post({ action: "save", ...input }))), [503, "unavailable"]);
  }
  is("no funnel, page or form was made by any of them", await counts(), [2, 2, 1]);
  await freshSaveWindows();
  is("control: the exact 'done' entry still reads as saved", ((await withLedgerReply(runAs(savedRun), async () => (await post({ action: "save", ...input })).json())) as { again?: boolean }).again, true);
  is("control: an exact 'started' entry reads as not saved yet", await withLedgerReply(runAs(JSON.stringify({ state: "started", at: 1 })), async () => ((await planFunnelImport((await storeForEmail(OWNER))!, input)).done)), null);
  is("control: still two funnels", await counts(), [2, 2, 1]);

  // Review of #2974 (LOW): the 503 "unavailable" this route sends on an unknown read is shown to the creator. It must
  // say what is true for a read that failed for now (and for imports not reachable at all): nothing was made, try
  // again; never that imports are not switched on.
  part("What the creator reads on a 503 'unavailable'");
  const unavailableLine = /\n\s*unavailable: "([^"]*)",/.exec(readFileSync("components/clickfunnels-funnel.tsx", "utf8"))?.[1] ?? "";
  is("it says nothing was made", unavailableLine.includes("nothing was made"), true);
  is("it says to try again in a moment", unavailableLine.includes("Try again in a moment."), true);
  is("it never says imports are not switched on", /not switched on/i.test(unavailableLine), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
