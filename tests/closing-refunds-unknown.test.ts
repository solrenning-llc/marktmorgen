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
  storeFolder: (email: string) => Promise<string>;
  storeRef: (store: unknown) => string;
};

const ENTRY = `
export { store as redis } from "./redis-stub";
export { who } from "./plan-refund-route-world";
export { FINAL_INDEX, paidKey } from "@/lib/closing-holds";
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
  const out = mkdtempSync(join(tmpdir(), "closing-refunds-unknown-"));
  // The real studio routing, with only the signed-in view taken from the stand-in.
  const route = join(out, "studio-route.ts");
  writeFileSync(route, `export * from ${JSON.stringify(join(root, "lib/studio-route.ts"))};\nexport { studioView } from ${JSON.stringify(join(here, "plan-refund-route-world.ts"))};\n`);
  const alias = {
    ...config.testAliases("closing-refunds-unknown.test.ts", root, here),
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

async function main() {
  const { world: w, cleanup } = await world();
  try {
    const store = { sid: "closingshop1", email: "owner@example.com", name: "Harbor", handle: "harbor" };
    w.who.store = store;
    w.who.role = "owner";
    const ref = w.storeRef(store);
    const paid = w.paidKey(await w.storeFolder(ref));
    const pipeline = w.redis.pipeline.bind(w.redis);
    let failOn = "";
    w.redis.pipeline = async (commands) => {
      if (failOn && commands.some((c) => c[0] === failOn)) throw new Error(`stand-in: ${failOn} could not be read`);
      return pipeline(commands);
    };

    part("The store's closing could not be read");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref]]);
    failOn = "ZSCORE";
    const unknownClosing = await w.render();
    failOn = "";
    is("never says the store is not closing", unknownClosing.includes(NOT_CLOSING), false);
    is("says it could not check, and to try again in a minute", unknownClosing.includes(CLOSING_UNKNOWN), true);
    is("says what still holds: nothing refunded here, the closing day's refunds still made", unknownClosing.includes("Nothing has been refunded from this page. If your store is closing, any refund a member is owed is still made for you on its closing day."), true);
    is("never says no member paid for time after it", unknownClosing.includes("No member has paid"), false);
    is("no refund button", unknownClosing.includes(BUTTON), false);

    part("The store is not closing (read, nothing found)");
    w.redis.clear();
    const notClosing = await w.render();
    is("the same words as before", notClosing.includes(NOT_CLOSING), true);
    is("not the words for a failed read", notClosing.includes("We could not"), false);
    is("no refund button", notClosing.includes(BUTTON), false);

    part("Closing, and the members' payments could not be read");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref]]);
    failOn = "HGETALL";
    const unknownPayments = await w.render();
    failOn = "";
    const day = dayWords(Date.now());
    is("never says no member paid for time after the closing day", unknownPayments.includes("No member has paid"), false);
    is("never says the store is not closing", unknownPayments.includes(NOT_CLOSING), false);
    is("says it could not read the payments, and to try again in a minute", unknownPayments.includes(PAYMENTS_UNKNOWN), true);
    is("says what still holds: the closing day, and its refunds made on it", unknownPayments.includes(`Nothing has been refunded from this page. Your store still closes on ${day}, and if you do nothing, any refund a member is owed is made for you on that day.`), true);
    is("no refund button", unknownPayments.includes(BUTTON), false);

    part("Closing, payments read, none owed");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref]]);
    const none = await w.render();
    is("the same words as before", none.includes(`No member has paid for time after ${dayWords(Date.now())}, the day your store closes, that is still to be refunded.`), true);
    is("not the words for a failed read", none.includes("We could not"), false);
    is("no refund button", none.includes(BUTTON), false);

    part("Closing, payments read, one owed");
    w.redis.clear();
    const now = Math.floor(Date.now() / 1000);
    await w.redis.pipeline([
      ["ZADD", w.FINAL_INDEX, Date.now() - 86_400_000, ref],
      ["HSET", paid, "sub_member01", JSON.stringify({ inv: "in_member01", amt: 1000, cur: "usd", ps: now - 15 * 86_400, pe: now + 15 * 86_400, e: "member@example.com" })],
    ]);
    const owed = await w.render();
    is("the member and the button", [owed.includes("member@example.com"), owed.includes("to 1 member"), owed.includes(BUTTON)], [true, true, true]);
    is("not the words for a failed read", owed.includes("We could not"), false);
  } finally {
    cleanup();
  }
  done();
}

void main();
