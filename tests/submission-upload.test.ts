/**
 * 750 [CD1] unit 2: the buyer's submission door, app/api/store/course/submission,
 * called through NextRequest with the store, the course, the learner and the
 * vault stood in for (tests/submission-upload-world.ts) and the real rules and
 * store on the in-memory Redis. What is checked:
 *
 *   - another site is refused before anything is read;
 *   - the store is read exactly (unknown is 503, none is 404) and one of its
 *     public requests is taken before anything else is read;
 *   - only the signed-in buyer of the course, on a lesson whose creator asked
 *     for submissions, opens; a free course, the creator, a closed course and
 *     a lesson with nothing asked are refused, and settings out of shape are unknown;
 *   - the file is checked against what was asked before any buyer action,
 *     allowance or storage is spent; a store without a paid plan takes none;
 *   - opening spends the buyer action, then the allowance, then the storage;
 *   - signing, closing and giving up are only for the buyer's own upload, and
 *     closing answers the record.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/course/submission/route";
import { saveSetupFor } from "@/lib/submission-store";
import type { SubmissionSetup } from "@/lib/submission-rules";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { COURSE, LESSON, resetWorld, state } from "./submission-upload-world";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const SETUP: SubmissionSetup = { instruction: "Film your squat from the side.", kinds: ["video"], maxBytes: 200 * MiB, keepDays: 30 };
const base = { handle: "shop", product: "prod1", lesson: LESSON };

async function call(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new NextRequest("https://marktmorgen.com/api/store/course/submission", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const open = (extra: Record<string, unknown> = {}) => call({ ...base, action: "open", name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4", ...extra });

async function main(): Promise<void> {
  part("Before anything is read");
  resetWorld();
  state.crossSite = true;
  is("another site is refused", (await open()).status, 403);
  is("and nothing is read", state.events, []);
  resetWorld();
  is("an action not known", (await call({ ...base, action: "delete" })).body, { ok: false, error: "invalid" });
  is("still nothing read", state.events, []);

  part("The store, then the public request, then the rest");
  resetWorld();
  state.found = "unknown";
  is("a store that could not be read is unknown", await open(), { status: 503, body: { ok: false, error: "unavailable" } });
  state.found = "none";
  is("no such store", (await open()).status, 404);
  resetWorld();
  state.hold = false;
  is("no public request left", await open(), { status: 503, body: { ok: false, error: "resting" } });
  is("so nothing else is read", state.events, ["read:store", "hold"]);

  part("Only the buyer, where the creator asked");
  resetWorld();
  is("nothing asked on this lesson", (await open()).body, { ok: false, error: "off" });
  await saveSetupFor(state.store as DataStore, COURSE, LESSON, SETUP);
  resetWorld();
  state.learner = null;
  is("signed out", await open(), { status: 401, body: { ok: false, error: "signed-out" } });
  resetWorld();
  state.access = "closed";
  is("not a buyer of the course", await open(), { status: 403, body: { ok: false, error: "not-buyer" } });
  resetWorld();
  state.access = "ended";
  is("a membership that ended", (await open()).body, { ok: false, error: "not-buyer" });
  resetWorld();
  state.priceCents = 0;
  is("a free course is not a purchase", (await open()).body, { ok: false, error: "not-buyer" });
  resetWorld();
  state.learner = { email: "owner@example.test", scope: "all", owner: true };
  is("the creator sends nothing to themselves", await open(), { status: 403, body: { ok: false, error: "owner" } });
  is("none of them spent anything", state.events.filter((e) => ["action", "budget", "vault:open"].includes(e)), []);
  resetWorld();
  await redis.pipeline([["SET", `nl:sub:setup:${COURSE}:${LESSON}`, "{broken"]]);
  is("settings out of shape are unknown", await open(), { status: 503, body: { ok: false, error: "unavailable" } });
  await saveSetupFor(state.store as DataStore, COURSE, LESSON, SETUP);

  part("The file, before anything is spent");
  resetWorld();
  is("a kind not asked for", await open({ type: "application/pdf", name: "a.pdf" }), { status: 400, body: { ok: false, error: "type" } });
  is("bigger than asked", (await open({ bytes: 200 * MiB + 1 })).body, { ok: false, error: "size" });
  is("no size", (await open({ bytes: "50" })).body, { ok: false, error: "size" });
  is("nothing spent for them", state.events.filter((e) => ["action", "budget", "vault:open"].includes(e)), []);
  resetWorld();
  state.store.subscriptionActive = false;
  state.store.trialEnds = Math.floor(Date.now() / 1000) + 86_400;
  is("a store on a trial takes no buyer files", await open(), { status: 409, body: { ok: false, error: "plan" } });
  resetWorld();
  state.rate = false;
  is("too many opens in an hour", (await open()).status, 429);
  is("before the buyer action", state.events.includes("action"), false);

  part("Opening");
  resetWorld();
  const first = await open();
  const upload = first.body.upload as { pathname: string } | undefined;
  is("it opens", first.status, 200);
  is("in this order", state.events, ["read:store", "hold", "read:listing", "read:course", "read:access", "limit:submission-open", "action", "budget", "vault:open"]);
  resetWorld();
  state.budget = false;
  is("no upload allowance left", await open(), { status: 503, body: { ok: false, error: "upload_budget_unavailable" } });
  is("the vault is not asked", state.events.includes("vault:open"), false);
  resetWorld();
  state.action = false;
  is("the store's buyer actions are used up", await open(), { status: 503, body: { ok: false, error: "resting" } });
  is("so no allowance is spent", state.events.includes("budget"), false);

  part("Signing, closing and giving up");
  const path = upload?.pathname ?? "";
  resetWorld();
  is("the buyer signs their pieces", (await call({ ...base, action: "sign", pathname: path, numbers: [1] })).status, 200);
  is("from the month's control requests", state.events.slice(-2), ["control", "sign"]);
  is("numbers that are not whole are refused", (await call({ ...base, action: "sign", pathname: path, numbers: [1, "2"] })).body, { ok: false, error: "invalid" });
  resetWorld();
  state.learner = { email: "bob@example.com", scope: "all", owner: false };
  is("another buyer cannot sign it", (await call({ ...base, action: "sign", pathname: path, numbers: [1] })).status, 404);
  is("nor close it", (await call({ ...base, action: "done", pathname: path, etags: ["e"] })).status, 404);
  is("nor give it up", (await call({ ...base, action: "abort", pathname: path })).status, 404);
  is("and the vault was asked nothing for them", state.events.filter((e) => e.startsWith("vault:") || e === "sign"), []);
  resetWorld();
  const closed = await call({ ...base, action: "done", pathname: path, etags: ["e"], note: "First try." });
  const sent = closed.body.submission as { file?: unknown; state?: unknown } | undefined;
  is("the buyer closes it", closed.status, 200);
  is("and is told what was kept", { file: sent?.file, state: sent?.state }, { file: { name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4" }, state: "submitted" });
  is("one buyer action for the record", state.events.filter((e) => e === "action").length, 1);
  resetWorld();
  const second = await open();
  resetWorld();
  is("the buyer gives up their own", await call({ ...base, action: "abort", pathname: (second.body.upload as { pathname: string }).pathname }), { status: 200, body: { ok: true } });
  resetWorld();
  state.learner = null;
  is("giving up needs the buyer signed in", (await call({ ...base, action: "abort", pathname: path })).status, 401);
}

main().then(done, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
