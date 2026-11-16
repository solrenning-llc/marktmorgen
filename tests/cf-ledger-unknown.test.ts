/**
 * Moving a ClickFunnels funnel (lib/clickfunnels-funnel.ts, app/api/store/import/funnel/route.ts): the run ledger
 * (nl:imports:cf:<sid>) is what makes the same import pressed again make nothing twice. Its HMGET is read only in
 * its exact shape (lib/redis-reply.ts, CX-123 rule 24): one reply for the one command, a list of exactly one slot per
 * field asked, each slot a string or nil. Anything else is unknown, never "never made": the plan and the save throw
 * UnknownReplyError, the route answers 503 "try_again", and nothing is made (sweep APP2 finding 5). Synthetic only.
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

  // Review of #2974 (comment 6698302076, LOW): "unavailable" tells the creator imports are not switched on, which is not
  // true of a read that failed for a moment; "try_again" says nothing was made and to try again.
  part("The route answers 503 'try_again' and makes nothing");
  is("save of the import already done", await withLedgerReply([{ 0: "x" }], async () => answer(await post({ action: "save", ...input }))), [503, "try_again"]);
  is("plan of it", await withLedgerReply([{ 0: "x" }], async () => answer(await post({ action: "plan", ...input }))), [503, "try_again"]);
  const other = { name: "Thanks only", pages: [pages[1]] };
  // Thanks only asks two fields (its run, its one page): one slot is one short.
  is("save of a new import", await withLedgerReply([[null]], async () => answer(await post({ action: "save", ...other }))), [503, "try_again"]);
  is("still two pages, one funnel, one form", await counts(), [2, 1, 1]);

  part("Exact nils still read as not made yet, and the lock was let go");
  is("the new import saves when the ledger answers in its shape", await answer(await post({ action: "save", ...other })), [200, "ok"]);
  is("its funnel is made, its page used again (the same page as before)", await counts(), [2, 2, 1]);

  // Review of #2974 (comment 6698302076, MEDIUM): the reply's shape is exact, but an entry in it is not one this file
  // writes. A run entry is only "started", "funnel" with its funnel's id, or "done" with what was made; a page entry is
  // only the 10-character id of the page made (rule 30). Anything else is unknown, never "never made": nothing is made again.
  part("An entry in the ledger that is not one this file writes is unknown, never 'never made'");
  const sid = (await storeForEmail(OWNER))!.sid!;
  const ledger = `nl:imports:cf:${sid}`;
  const runField = `run:${(await planFunnelImport((await storeForEmail(OWNER))!, input)).key}`;
  const entries = (await redis.pipeline([["HGETALL", ledger]]))[0] as string[];
  const fields = new Map<string, string>();
  for (let i = 0; i + 1 < entries.length; i += 2) fields.set(entries[i], entries[i + 1]);
  const pageField = [...fields.keys()].find((f) => f.startsWith("page:")) ?? "";
  is("the done run and a page entry are in the ledger", [(fields.get(runField) ?? "").includes(`"state":"done"`), Boolean(pageField)], [true, true]);
  const badRuns: [string, string][] = [
    ["not JSON", "not json"],
    ["an empty string", ""],
    ["JSON null", "null"],
    ["a number", "5"],
    ["a list", "[]"],
    ["an unknown state", `{"state":"weird"}`],
    ["no state", `{"funnel":"abcdefghij"}`],
    ["done without the funnel's id", `{"state":"done","funnel":{}}`],
    ["done without its pages", `{"state":"done","funnel":{"id":"abcdefghij","name":"Free plan funnel","slug":"free-plan-funnel"},"bumps":0,"offers":0,"at":1}`],
    ["funnel without the funnel's id", `{"state":"funnel","at":1}`],
    ["funnel with a number for its id", `{"state":"funnel","funnel":5,"at":1}`],
  ];
  const badPages: [string, string][] = [
    ["an empty string", ""],
    ["JSON instead of an id", `{"id":"abc"}`],
    ["an id of the wrong length", "abc"],
  ];
  const cases: [string, string, string][] = [
    ...badRuns.map(([what, value]): [string, string, string] => [`run entry, ${what}`, runField, value]),
    ...badPages.map(([what, value]): [string, string, string] => [`page entry, ${what}`, pageField, value]),
  ];
  const viaRoute = new Set(["run entry, not JSON", "run entry, done without the funnel's id", "page entry, an id of the wrong length"]);
  for (const [what, field, value] of cases) {
    const kept = fields.get(field) ?? "";
    await redis.pipeline([["HSET", ledger, field, value]]);
    try {
      is(`plan: ${what}: throws UnknownReplyError`, await thrown(async () => planFunnelImport((await storeForEmail(OWNER))!, input)), "UnknownReplyError");
      is(`save: ${what}: throws UnknownReplyError`, await thrown(async () => saveFunnelImport((await storeForEmail(OWNER))!, input)), "UnknownReplyError");
      // The route's saves are held to 10 a day per creator (import-cf-save): three of these go through it, the rest through the library.
      if (viaRoute.has(what)) is(`route save: ${what}: answers 503 try_again`, await answer(await post({ action: "save", ...input })), [503, "try_again"]);
      is(`${what}: nothing is made`, await counts(), [2, 2, 1]);
    } finally {
      await redis.pipeline([["HSET", ledger, field, kept]]);
    }
  }

  part("The entries this file writes still read as they did");
  is("the done run, put back: saved again makes nothing", ((await (await post({ action: "save", ...input })).json()) as { again?: boolean }).again, true);
  const doneRun = fields.get(runField) ?? "";
  await redis.pipeline([["HSET", ledger, runField, JSON.stringify({ state: "started", at: 1 })]]);
  is("a started run reads as not finished, with no error", await thrown(async () => planFunnelImport((await storeForEmail(OWNER))!, input)), "no error");
  const funnelId = (JSON.parse(doneRun || "{}") as { funnel?: { id?: string } }).funnel?.id ?? "";
  await redis.pipeline([["HSET", ledger, runField, JSON.stringify({ state: "funnel", funnel: funnelId, at: 1 })]]);
  is("a run stopped after its funnel is resumed with that funnel", (await planFunnelImport((await storeForEmail(OWNER))!, input)).partial, funnelId);
  await redis.pipeline([["HSET", ledger, runField, doneRun]]);
  is("still two pages, two funnels, one form", await counts(), [2, 2, 1]);

  part("The creator is told what is true about it");
  const words = readFileSync("components/clickfunnels-funnel.tsx", "utf8");
  is("the studio's words for try_again", words.includes(`try_again: "Nothing was made. Try again in a moment.",`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
