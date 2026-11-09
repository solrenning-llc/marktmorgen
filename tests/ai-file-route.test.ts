/**
 * The route of the product's file written with AI (758 [STN5], unit 3;
 * app/api/store/ai-file/route.ts). The model is played by a stand-in for
 * `fetch`; the database is the in-memory one. What is checked:
 *   - only a draft product that hands over nothing yet; a published one is
 *     refused before anything is taken or asked;
 *   - nothing is asked while the file could not be kept (no file store);
 *   - the plan comes back as one answer; the parts as lines, a padding line
 *     first, each part as it starts and ends, then the file, and the run then
 *     allows one save;
 *   - a save waits for the three checks under the AI draft (756 [STN3]) and
 *     for a run that allows it; a run id that is not one is refused.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SECTION_END } from "@/lib/ai-file-rules";
import { POST } from "@/app/api/store/ai-file/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "file.route@example.com";
const ORIGIN = "https://marktmorgen.com";
const PLAN = { title: "Weeknight Dinners", sections: [{ title: "Start here", points: ["What to buy"] }, { title: "Week one", points: [] }] };
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string };
  const text = String(body.system).startsWith("You plan a guide") ? JSON.stringify(PLAN) : `Cook the rice first.\n\nThen the beans.\n\n${SECTION_END}`;
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

const VAULT = { R2_ACCOUNT_ID: "c".repeat(32), R2_ACCESS_KEY_ID: "FILEROUTEKEY0000001", R2_SECRET_ACCESS_KEY: "s".repeat(40), R2_BUCKET: "marktmorgen-files" };

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle(OWNER, "fileroute", "File Route", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FileRt00001", subscriptionId: "sub_FileRt00001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const draft = await addProduct(OWNER, "Recipe Guide", "Weeknight dinners", "27", null);
  const shown = await addProduct(OWNER, "Recipe Pack", "Forty dinners", "27", null);
  if (!draft.ok || !shown.ok) throw new Error("no product");
  await setProductHidden(OWNER, draft.product.id, true);
  await setProductHidden(OWNER, shown.product.id, false);
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const ask = (body: Record<string, unknown>) =>
    POST(new NextRequest(`${ORIGIN}/api/store/ai-file`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const json = async (response: Response): Promise<[number, Record<string, unknown>]> => [response.status, (await response.json().catch(() => ({}))) as Record<string, unknown>];

  part("Nothing is asked while the file could not be kept");
  for (const name of Object.keys(VAULT)) delete process.env[name];
  is("no file store: refused", await json(await ask({ action: "outline", product: draft.product.id, notes: "Dinners" })), [503, { ok: false, error: "off" }]);
  is("no model call", calls, 0);
  Object.assign(process.env, VAULT);

  part("Only a draft that hands over nothing yet");
  is("a published product is refused", await json(await ask({ action: "outline", product: shown.product.id, notes: "Dinners" })), [409, { ok: false, error: "published" }]);
  is("an unknown product is refused", await json(await ask({ action: "outline", product: "nope", notes: "Dinners" })), [404, { ok: false, error: "unknown" }]);
  is("an action that is not one is refused", await json(await ask({ action: "publish", product: draft.product.id })), [400, { ok: false, error: "invalid" }]);
  is("no model call", calls, 0);

  part("The plan, as one answer");
  const [status, planned] = await json(await ask({ action: "outline", product: draft.product.id, notes: "Weeknight dinners for busy parents." }));
  is("the plan and what is left", [status, planned.ok, planned.value, typeof planned.left], [200, true, PLAN, "number"]);
  is("one model call", calls, 1);

  part("The parts, as lines");
  calls = 0;
  is("a run id that is not one is refused before anything", await json(await ask({ action: "sections", product: draft.product.id, outline: PLAN, run: "nope", notes: "" })), [400, { ok: false, error: "invalid" }]);
  is("a plan not read exactly is refused before anything", await json(await ask({ action: "sections", product: draft.product.id, outline: { ...PLAN, extra: 1 }, run: "fileroutenotread1", notes: "" })), [400, { ok: false, error: "invalid" }]);
  is("no model call", calls, 0);
  const run = "fileroutewrite001";
  const stepped = await ask({ action: "sections", product: draft.product.id, outline: PLAN, run, notes: "" });
  is("a stream of lines", [stepped.status, stepped.headers.get("content-type"), stepped.headers.get("cache-control")], [200, "application/x-ndjson; charset=utf-8", "no-store"]);
  const lines = (await stepped.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  is("a padding line first, of at least a kilobyte", [Object.keys(lines[0] ?? {}), new TextEncoder().encode(JSON.stringify(lines[0])).length >= 1024], [["pad"], true]);
  const steps = lines.slice(1, -1) as { step: string; state: string }[];
  is("each part said as it starts and ends", [steps.filter((s) => s.state === "started").map((s) => s.step), steps.filter((s) => s.state === "done").map((s) => s.step).sort()], [["section-1", "section-2"], ["section-1", "section-2"]]);
  const last = lines[lines.length - 1] as { done?: boolean; ok?: boolean; value?: { sections?: { title: string; body: string }[] } };
  is("then the file, part by part", [last.done, last.ok, last.value?.sections?.map((s) => s.title)], [true, true, ["Start here", "Week one"]]);
  is("two model calls", calls, 2);
  is("the run allows one save", redis.run(["GET", `nl:ai:file:${store.statsId}:${run}`]), "1");

  part("The save waits for the checks and for a run");
  const text = { title: "Weeknight Dinners", sections: [{ title: "Start here", body: "Cook the rice first.\n\nThen the beans." }] };
  is("without the three checks: refused", await json(await ask({ action: "save", product: draft.product.id, run, draft: text, checks: [true, true, false] })), [400, { ok: false, error: "unchecked" }]);
  is("the run's save is still there", redis.run(["GET", `nl:ai:file:${store.statsId}:${run}`]), "1");
  is("a run that allows none: refused", await json(await ask({ action: "save", product: draft.product.id, run: "fileroutenosave01", draft: text, checks: [true, true, true] })), [409, { ok: false, error: "expired" }]);
  is("a text not read exactly: refused", await json(await ask({ action: "save", product: draft.product.id, run, draft: { ...text, html: "<b>" }, checks: [true, true, true] })), [400, { ok: false, error: "invalid" }]);
  is("a published product: refused before anything", await json(await ask({ action: "save", product: shown.product.id, run, draft: text, checks: [true, true, true] })), [409, { ok: false, error: "published" }]);
  is("the draft product is still a draft, with no file", [(await readListing(store, draft.product.id))?.hidden, (await readListing(store, draft.product.id))?.file], [true, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
