/** Independent SSR review of #2971. Product modules and author tests stay read-only. */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import NumbersLinkPage from "@/app/numbers/[id]/page";
import { addNumbersLink, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { cookieName, indexLink, makeLink, passCookie } from "@/lib/numbers-links";
import { readVerified, type Verified } from "@/lib/verified-numbers";
import { store as redis } from "@/tests/redis-stub";

const cookieJar = new Map<string, string>();
/** Only the Next request context is adapted; the page and its data readers are real. */
export async function cookies() {
  return { get: (name: string) => cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined };
}
export async function headers() {
  return new Headers({ host: "marktmorgen.test", "x-forwarded-for": "203.0.113.7", "user-agent": "Synthetic local review" });
}

type Batch = Parameters<typeof redis.pipeline>[0];
type Failure = { scenario: string; name: string; actual: unknown; expected: unknown };
const scenarios = ["healthy", "confirmed-missing-link", "unknown-open-count", "thrown-open-count", "thrown-verified-read", "unknown-verified-read", "unknown-store-read", "confirmed-missing-verified"] as const;
const COMMANDS_PER_CASE = 1_000;
const NOW = Date.UTC(2026, 10, 6, 12);

export async function auditNumbersLink() {
  // Admit all eight cases before the first application/inspection dispatch.
  assert.equal(scenarios.length, 8);
  const commands = new Map<string, number>(scenarios.map(name => [name, 0]));
  const pipeline = redis.pipeline.bind(redis), fetchBefore = globalThis.fetch, clock = Date.now, errorBefore = console.error;
  const failures: Failure[] = [], observations: Record<string, unknown>[] = [], errors: string[] = [];
  let scenario: string = scenarios[0], checks = 0, forbiddenFetches = 0;
  let fault: ((batch: Batch) => unknown[] | undefined) | null = null;
  const check = (name: string, actual: unknown, expected: unknown) => {
    checks++;
    try { assert.deepEqual(actual, expected); }
    catch { failures.push({ scenario, name, actual, expected }); }
  };
  redis.clear();
  cookieJar.clear();
  Date.now = () => NOW;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ").slice(0, 500)); };
  globalThis.fetch = (async () => { forbiddenFetches++; throw Error("No HTTP or provider operation is admitted"); }) as typeof fetch;
  redis.pipeline = async batch => {
    const n = commands.get(scenario);
    assert.notEqual(n, undefined);
    assert.ok(n! + batch.length <= COMMANDS_PER_CASE, "admit application commands before dispatch");
    commands.set(scenario, n! + batch.length);
    const injected = fault?.(batch);
    return injected === undefined ? pipeline(batch) : injected;
  };
  try {
    await claimHandle("review2971@example.com", "review2971", "Synthetic link shop", "");
    await ensureStoreId("review2971@example.com");
    await ensureStatsId("review2971@example.com");
    const made = makeLink({ label: "Synthetic shared numbers", password: "synthetic-review-password", days: 30, money: false }, NOW);
    assert.ok(made.ok);
    await addNumbersLink("review2971@example.com", made.link, NOW);
    const store = await storeForEmail("review2971@example.com");
    assert.ok(store?.statsId && store.sid);
    await indexLink(store.sid, made.link, NOW);
    const cookie = passCookie(made.link, NOW);
    assert.ok(cookie, "the real signer must produce the page's cookie");
    cookieJar.set(cookieName(made.link.id), cookie);
    const window = { visitors: 742, views: 1_484, checkouts: 12, sales: null, cents: null };
    const record: Verified = {
      coverageVersion: 1, day: "2026-11-06", at: NOW / 1000, currency: "usd", salesRead: false,
      windows: { d7: window, d30: window, d90: window }, channels: [], products: [], countries: [],
    };
    const verifiedKey = `nl:verified:${store.statsId}`, storeKey = `nl:store:id:${store.sid}`;
    const raw = JSON.stringify(record);
    await redis.pipeline([["SET", verifiedKey, raw]]);
    assert.deepEqual(await readVerified(store), record, "the real reader must accept the typed fixture");
    const render = async (id = made.link.id) => {
      const html = renderToStaticMarkup(await NumbersLinkPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
      const state = {
        unread: html.includes("These numbers could not be read just now"),
        ended: html.includes("This link has ended"),
        overUsed: html.includes("Opened too many times today"),
        recorded: html.includes("data-numbers-link"),
        noRecorded: html.includes("No recorded numbers are available"),
        status: html.includes('role="status"'),
      };
      observations.push({ scenario, ...state });
      return { html, ...state };
    };
    const healthy = await render();
    check("the real signed-cookie page displays its confirmed record", healthy.recorded && healthy.html.includes("742"), true);
    check("the healthy link is neither unread, ended nor over-used", [healthy.unread, healthy.ended, healthy.overUsed], [false, false, false]);

    scenario = scenarios[1];
    const missing = await render("z".repeat(20));
    check("confirmed link absence keeps ended wording", [missing.ended, missing.unread], [true, false]);

    scenario = scenarios[2];
    fault = batch => batch[0]?.[0] === "INCR" && String(batch[0][1]).startsWith("nl:nlink:opens:") ? [] : undefined;
    const unknownCount = await render(); fault = null;
    check("an unknown count renders the real unread status", [unknownCount.unread, unknownCount.status], [true, true]);
    check("an unknown count is neither ended nor over-used", [unknownCount.ended, unknownCount.overUsed], [false, false]);

    scenario = scenarios[3];
    fault = batch => { if (batch[0]?.[0] === "INCR" && String(batch[0][1]).startsWith("nl:nlink:opens:")) throw Error("synthetic count read failure"); return undefined; };
    const thrownCount = await render(); fault = null;
    check("a thrown count renders the real unread status", [thrownCount.unread, thrownCount.status], [true, true]);
    check("a thrown count is never over-used", thrownCount.overUsed, false);

    scenario = scenarios[4];
    fault = batch => { if (batch[0]?.[0] === "GET" && batch[0][1] === verifiedKey) throw Error("synthetic verified read failure"); return undefined; };
    const thrownVerified = await render(); fault = null;
    check("a thrown verified read renders the real unread status", [thrownVerified.unread, thrownVerified.status], [true, true]);
    check("a thrown verified read does not invent absence", thrownVerified.noRecorded, false);

    scenario = scenarios[5];
    fault = batch => batch[0]?.[0] === "GET" && batch[0][1] === verifiedKey ? [7] : undefined;
    const unknownVerified = await render(); fault = null;
    check("an unknown verified reply is unread, not confirmed absent", [unknownVerified.unread, unknownVerified.noRecorded], [true, false]);
    const [stillKept] = await redis.pipeline([["GET", verifiedKey]]);
    check("the verified record was not lost from the fixture", stillKept, raw);

    scenario = scenarios[6];
    fault = batch => batch[0]?.[0] === "GET" && batch[0][1] === storeKey ? [7] : undefined;
    const unknownStore = await render(); fault = null;
    check("an unknown store reply is unread, not ended", [unknownStore.unread, unknownStore.ended], [true, false]);
    const [stillMapped] = await redis.pipeline([["GET", storeKey]]);
    check("the confirmed store mapping remains stored", typeof stillMapped, "string");

    scenario = scenarios[7];
    await redis.pipeline([["DEL", verifiedKey]]);
    const absentVerified = await render();
    check("confirmed snapshot absence retains its existing wording", [absentVerified.noRecorded, absentVerified.unread], [true, false]);
    check("no network or provider was contacted", forbiddenFetches, 0);
    return { checks, failures, observations, commands: Object.fromEntries(commands), errors, forbiddenFetches, bounds: { cases: scenarios.length, commandsPerCase: COMMANDS_PER_CASE, commandCeiling: scenarios.length * COMMANDS_PER_CASE } };
  } finally {
    redis.pipeline = pipeline; globalThis.fetch = fetchBefore; Date.now = clock; console.error = errorBefore; cookieJar.clear();
  }
}
