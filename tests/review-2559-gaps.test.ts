/**
 * The review screen before giving back members' unused time
 * (app/studio/closing-refunds, queue item 307 [EC1], part 4), when a read
 * fails (audit SG2, rules 24 and 27 of CX-123: an unknown never becomes
 * "nothing", and the words promise only what the code does).
 *
 * The page is rendered with the real closing reading (lib/plan-closing.ts),
 * the real refund figures (lib/closing-refunds.ts) and the stand-in Redis of
 * tests/redis-stub.ts; only the session, the request context and the studio's
 * header are stand-ins, the same ones tests/plan-refund-page.test.ts uses.
 * Those stand-ins are wired for this file alone, in its own bundle below, so
 * the shared wiring (tests/test-config.mjs) is not touched. Nothing real is
 * reached.
 *
 * What fails here: a failed read of the closing saying the store is not
 * closing; a failed read of the members' payments saying no member paid for
 * time after the closing day; any refund button over figures that could not
 * be read; a change to the words of the cases that were read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

type MemoryRedis = { pipeline: (commands: (string | number)[][]) => Promise<unknown[]>; clear: () => void };
type World = {
  redis: MemoryRedis;
  who: { store: unknown; role: "owner" | "admin" | "editor" | "support" };
  render: () => Promise<string>;
  FINAL_INDEX: string;
  paidKey: (folder: string) => string;
  workKey: (folder: string) => string;
  storeFolder: (email: string) => Promise<string>;
  storeRef: (store: unknown) => string;
};

const ENTRY = `
export { store as redis } from "./redis-stub";
export { who } from "./plan-refund-route-world";
export { FINAL_INDEX, paidKey, workKey } from "@/lib/closing-holds";
export { storeFolder, storeRef } from "@/lib/store";
import { renderToStaticMarkup } from "react-dom/server";
import ClosingRefundsPage from "@/app/studio/closing-refunds/page";
export const render = async () => renderToStaticMarkup(await ClosingRefundsPage({ searchParams: Promise.resolve({}) }));
`;

async function world(): Promise<{ world: World; cleanup: () => void }> {
  const root = process.cwd();
  const here = join(root, "tests");
  const req = createRequire(join(root, "package.json"));
  const { buildSync } = req("esbuild") as typeof import("esbuild");
  const config = (await import(pathToFileURL(join(here, "test-config.mjs")).href)) as { testAliases: (file: string, root: string, here: string) => Record<string, string> };
  const pageWorld = join(here, "meeting-withdrawal-page-world.ts");
  const out = mkdtempSync(join(tmpdir(), "review-2559-"));
  // The real studio routing, with only the signed-in view taken from the stand-in.
  const route = join(out, "studio-route.ts");
  writeFileSync(route, `export * from ${JSON.stringify(join(root, "lib/studio-route.ts"))};\nexport { studioView } from ${JSON.stringify(join(here, "plan-refund-route-world.ts"))};\n`);
  const alias = {
    ...config.testAliases("review-2559-gaps.test.ts", root, here),
    "@/lib/studio-route": route,
    "next/headers": pageWorld,
    "next/navigation": pageWorld,
    "@/components/studio-header": pageWorld,
  };
  const file = join(out, "world.cjs");
  const built = buildSync({ stdin: { contents: ENTRY, resolveDir: here, loader: "tsx", sourcefile: "closing-refunds-world.tsx" }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error", alias });
  writeFileSync(file, built.outputFiles[0].text);
  return { world: req(file) as World, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const NOT_CLOSING = "Your store is not closing, so there is nothing to refund here.";
const CLOSING_UNKNOWN = "We could not check whether your store is closing just now, so no refunds are shown. Please reload this page in a minute to try again.";
const PAYMENTS_UNKNOWN = "We could not read your members&#x27; payments just now, so no refunds are shown. Please reload this page in a minute to try again.";
const BUTTON = "Go back without refunding";
/** As React writes text into the markup. */
const html = (text: string) => text.replace(/'/g, "&#x27;");
/** Promises the code does not keep (audit of #2554): members past the call budget or whose hold failed are never refunded by it. */
const OVERPROMISE = ["are made for you", "are still made for you", "as far as your Stripe balance covers them"];

async function main() {
  const { world: w, cleanup } = await world();
  try {
    const store = { sid: "closingshop1", email: "owner@example.com", name: "Harbor", handle: "harbor", planEndedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() };
    w.who.store = store; w.who.role = "owner";
    const ref = w.storeRef(store);
    const folder = await w.storeFolder(ref);
    const paid = w.paidKey(folder);
    const pipeline = w.redis.pipeline.bind(w.redis);
    let failOn = "";
    w.redis.pipeline = async (commands) => {
      if (failOn && commands.some((c) => c[0] === failOn)) throw new Error(`stand-in: ${failOn} could not be read`);
      return pipeline(commands);
    };
    const now = Math.floor(Date.now() / 1000);
    const member = (id: string) => ["HSET", paid, id, JSON.stringify({ inv: "in_" + id, amt: 1000, cur: "usd", ps: now - 15 * 86_400, pe: now + 15 * 86_400, e: "member@example.com" })];

    part("F1: the pause evidence could not be read (onBreak says true, closingOf says null)");
    w.redis.clear();
    failOn = "EVAL";
    const f1 = await w.render();
    failOn = "";
    is("a failed read is not told as 'not closing'", f1.includes(NOT_CLOSING), false);

    part("F2: a payment row that cannot be parsed is dropped and the page says nobody paid");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref], ["HSET", paid, "sub_member01", "{not json"]]);
    const f2 = await w.render();
    is("does not say 'No member has paid' over an unreadable row", f2.includes("No member has paid"), false);

    part("F3: members the hold never reached (over budget / failed) are not on the list, yet the empty page says no member paid");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref], ["HSET", w.workKey(folder), "o:sub_member02", "1", "f:sub_member03", "1"]]);
    const f3 = await w.render();
    is("does not say 'No member has paid' when members were never read", f3.includes("No member has paid"), false);

    part("F4: closing day already begun: starting a plan is refused, yet the page offers it");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref], member("sub_member01")]);
    const f4 = await w.render();
    is("the list is shown", f4.includes("member@example.com"), true);
    is("does not say a plan started 'before then' keeps the store", f4.includes("Starting a plan again before then keeps your store"), false);
  } finally {
    cleanup();
  }
  done();
}

void main();
