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
/** The same two sentences close every state that names the closing day: what is tried, and who is the creator's to refund. */
const CAN_FAIL = "A refund can fail, for example when your balance is too low.";
const UNLISTED = "If someone paid for time after that day and is not listed, refund them in Stripe.";
const CLOSING_UNKNOWN = `We could not check whether your store is closing just now. Please reload this page in a minute. If your store is closing, on its closing day we try to make the refunds this page lists, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}`;
const PAYMENTS_UNKNOWN = (day: string) => `We could not read your members' payments just now. Please reload this page in a minute. Your store is set to close on ${day}. On that day we try to make the refunds this page lists, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}`;
const NONE_LISTED = (day: string) => `This page lists no refund to make. Your store is set to close on ${day}. ${UNLISTED}`;
const LISTED = (day: string) => `If you do nothing, we try to make the same refunds on ${day}, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}`;
const PLAN_AGAIN = "Starting a plan again before then keeps your store, and then nothing is refunded.";
const BUTTON = "Go back without refunding";
/** As React writes text into the markup. */
const html = (text: string) => text.replace(/'/g, "&#x27;");
/**
 * Promises the code does not keep (independent reviews of #2554 and #2559): members past the hold's call
 * budget, whose hold failed, on a payment plan, or who paid before the hold ran are never on the list, and a
 * listed refund can still fail; so no state says every member's refund is made, or that no member paid.
 */
const OVERPROMISE = ["are made for you", "are still made for you", "as far as your Stripe balance covers them", "No member has paid"];
const DAY_MS = 86_400_000;

/*
 * F3 and F4 of the independent review of #2559 (tests/review-2559-gaps.test.ts on claude4/review-2559-red) are
 * carried here. Its F1 (closingOf and a failed break read) and F2 (paidPeriods dropping rows) are not: they are
 * about lib/plan-closing.ts and lib/closing-holds.ts, which belong to other pull requests.
 */
async function main() {
  const { world: w, cleanup } = await world();
  try {
    const store = { sid: "closingshop1", email: "owner@example.com", name: "Harbor", handle: "harbor" };
    w.who.store = store;
    w.who.role = "owner";
    const ref = w.storeRef(store);
    const folder = await w.storeFolder(ref);
    const paid = w.paidKey(folder);
    const now = Math.floor(Date.now() / 1000);
    const member = (key: string, id: string, pe = now + 15 * 86_400) => ["HSET", key, id, JSON.stringify({ inv: "in_" + id.slice(4), amt: 1000, cur: "usd", ps: now - 15 * 86_400, pe, e: "member@example.com" })];
    const pipeline = w.redis.pipeline.bind(w.redis);
    let failOn = "";
    w.redis.pipeline = async (commands) => {
      if (failOn && commands.some((c) => c[0] === failOn)) throw new Error(`stand-in: ${failOn} could not be read`);
      return pipeline(commands);
    };
    const today = dayWords(Date.now());

    part("The store's closing could not be read");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref]]);
    failOn = "ZSCORE";
    const unknownClosing = await w.render();
    failOn = "";
    is("never says the store is not closing", unknownClosing.includes(NOT_CLOSING), false);
    is("says it could not check, to reload in a minute, what is tried, that it can fail, and who is the creator's to refund", unknownClosing.includes(html(CLOSING_UNKNOWN)), true);
    is("no refund button", unknownClosing.includes(BUTTON), false);
    is("no promise the code does not keep", OVERPROMISE.filter((p) => unknownClosing.includes(p)), []);

    part("The store is not closing (read, nothing found)");
    w.redis.clear();
    const notClosing = await w.render();
    is("the same words as before", notClosing.includes(NOT_CLOSING), true);
    is("not the words for a failed read", notClosing.includes("We could not"), false);
    is("no refund button", notClosing.includes(BUTTON), false);

    part("Closing, and the members' payments could not be read");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref]]);
    failOn = "HGETALL";
    const unknownPayments = await w.render();
    failOn = "";
    is("never says the store is not closing", unknownPayments.includes(NOT_CLOSING), false);
    is("says it could not read, to reload in a minute, the day, what is tried, that it can fail, and who is the creator's to refund", unknownPayments.includes(html(PAYMENTS_UNKNOWN(today))), true);
    is("no refund button", unknownPayments.includes(BUTTON), false);
    is("no promise the code does not keep", OVERPROMISE.filter((p) => unknownPayments.includes(p)), []);

    part("Closing, payments read, none listed");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref]]);
    const none = await w.render();
    is("says only that the page lists none, the day, and who is the creator's to refund", none.includes(html(NONE_LISTED(today))), true);
    is("not the words for a failed read", none.includes("We could not"), false);
    is("no refund button", none.includes(BUTTON), false);
    is("no promise the code does not keep", OVERPROMISE.filter((p) => none.includes(p)), []);

    part("F3: members the hold never reached (over its budget, failed) are not listed; the page never says no member paid");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref], ["HSET", w.workKey(folder), "o:sub_member02", "1", "f:sub_member03", "1"]]);
    const unreached = await w.render();
    is("does not say 'No member has paid'", unreached.includes("No member has paid"), false);
    is("tells the creator that anyone not listed is theirs to refund in Stripe", unreached.includes(UNLISTED), true);

    part("F4: one listed, and the closing day has begun (starting a plan is refused then)");
    w.redis.clear();
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref], member(paid, "sub_member01")]);
    const owed = await w.render();
    is("the member and the button", [owed.includes("member@example.com"), owed.includes("to 1 member"), owed.includes(BUTTON)], [true, true, true]);
    is("not the words for a failed read", owed.includes("We could not"), false);
    is("says only what is done: the same refunds tried that day, that one can fail, and who is the creator's to refund", owed.includes(html(LISTED(today))), true);
    is("never offers starting a plan again to keep the store", owed.includes(PLAN_AGAIN), false);
    is("no promise the code does not keep", OVERPROMISE.filter((p) => owed.includes(p)), []);

    part("One listed, before the closing day (starting a plan still keeps the store)");
    w.redis.clear();
    const ending = { ...store, sid: "closingshop2", email: "ending@example.com", planEndedAt: new Date(Date.now() - DAY_MS).toISOString() };
    w.who.store = ending;
    await w.redis.pipeline([member(w.paidKey(await w.storeFolder(w.storeRef(ending))), "sub_member04", now + 90 * 86_400)]);
    const before = await w.render();
    is("the member and the button", [before.includes("member@example.com"), before.includes(BUTTON)], [true, true]);
    is("says starting a plan again before then keeps the store", before.includes(PLAN_AGAIN), true);
    is("no promise the code does not keep", OVERPROMISE.filter((p) => before.includes(p)), []);
    w.who.store = store;
  } finally {
    cleanup();
  }
  done();
}

void main();
