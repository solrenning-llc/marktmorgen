/**
 * A closed store whose Stripe never answers (owner's decision DONO-3, 9 November 2026).
 *
 * Until this, a store at its closing day whose Stripe could not be asked (whether its plan runs, whether its
 * members' renewals stopped, whether a plan paid late was returned) was "held" each day for ever, and everything
 * it kept, people's records with it, stayed with no date (L4 of an earlier review). The owner's decision: kept
 * for the longest time already set and no longer, the case written down; at its end its personal records are
 * deleted by the deletion that already exists, and only the company's record (the dates) stays.
 *
 * The time already set is the privacy policy's and the terms' ERASE_WITHIN_DAYS after the closing day; one
 * walk's room (ERASE_EVERY_DAYS) is left inside it for the deletion itself, so Stripe gets the rest:
 * ERASE_WITHIN_DAYS - ERASE_EVERY_DAYS days after the day. What these hold, against stand-ins only:
 *
 *   - Stripe silent until then: held every day before it, nothing removed; on it, the store closes without
 *     Stripe, its files go, it is put in line for the walk, the case is written down (`lapsed`), and after the
 *     walk only its dated closing record is left;
 *   - the same when the silence is on its closing day's own steps (a late plan's check, its renewals);
 *   - Stripe that answers before then is the ordinary closing, with no `lapsed`;
 *   - Stripe that answers after it, that the plan runs, still keeps the store: the deadline replaces a hold,
 *     never an answer;
 *   - a store not asked at all (the daily recheck budget) is never taken for a silent one.
 */
import { createHash } from "node:crypto";
import { type Hands, closeOne, finishClosed } from "@/lib/plan-closing";
import { DUE_KEY, eraseClosed } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { CLOSING_DAYS, ERASE_EVERY_DAYS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { addProduct, claimHandle, setProductFile, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { vaultPath } from "@/lib/vault-rules";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 24 * 60 * 60 * 1000;
const C = CLOSING_DAYS;
const M = CLOSING_DAYS - WARN_MONTH_DAYS;
const W = CLOSING_DAYS - WARN_WEEK_DAYS;
/** The days after the closing day Stripe is waited for: the time already set, less one walk's room. */
const SILENT = ERASE_WITHIN_DAYS - ERASE_EVERY_DAYS;
const LIBRARY = "4242";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stateKey = (key: string) => `nl:plan:closing:${sha(key).slice(0, 40)}`;

// ------------------------------------------------------------- stand-ins

/** The file store, by path. */
const objects = new Map<string, number>();
let fileStore: "up" | "down" = "up";
/** Stripe, as the platform (plans) and as the creators' connected accounts (what they sold). */
let platform: "up" | "down" = "up";
let connected: "up" | "down" = "up";
const running = new Map<string, Record<string, unknown>>();
const posted: string[] = [];
const sent: { to: string[]; subject: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN) {
    if (url.pathname.endsWith("/videos") && method === "GET") return json({ totalItems: 0, currentPage: 1, itemsPerPage: 1000, items: [] });
    return json({}, 404);
  }
  if (url.origin === "https://api.stripe.com") {
    const headers = new Headers(init?.headers);
    const onAccount = headers.has("Stripe-Account");
    if ((onAccount ? connected : platform) === "down") throw new TypeError("fetch failed");
    if (method !== "GET") posted.push(`${method} ${url.pathname}`);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/subscriptions/search") {
      const query = url.searchParams.get("query") ?? "";
      return json({ object: "search_result", data: [...running.entries()].filter(([handle]) => query.includes(`'${handle}'`)).map(([, row]) => row), has_more: false, next_page: null });
    }
    if (path === "/subscriptions") return json({ object: "list", data: [], has_more: false });
    if (path === "/checkout/sessions" && method === "GET") return json({ object: "list", data: [], has_more: false });
    const one = [...running.values()].find((row) => path === `/subscriptions/${String(row.id)}`);
    if (one) return json(one);
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as { to: string[]; subject: string });
    return json({ id: `email-${sent.length}` });
  }
  return new Response(null, { status: 404 });
}) as typeof fetch;

const hands: Hands = {
  measure: async (folder) => [...objects].filter(([path]) => path.startsWith(`vault/${folder}/`)).reduce((sum, [, bytes]) => sum + bytes, 0),
  list: async (prefix) => {
    if (fileStore === "down") throw new Error("the file store is down");
    return [...objects.keys()].filter((path) => path.startsWith(prefix));
  },
  remove: async (paths) => {
    if (fileStore === "down") throw new Error("the file store is down");
    for (const path of paths) objects.delete(path);
  },
};

// ---------------------------------------------------------------- stores

type Made = { email: string; handle: string; folder: string; ended: number };
let tokens = 0;

/** A store on a paid plan with one file, whose plan then ends. */
async function closingStore(handle: string): Promise<Made> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} studio`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}0001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const folder = await storeFolder(email);
  const added = await addProduct(email, "Guide", "", "19", null);
  if (!added.ok) throw new Error(`no product: ${added.reason}`);
  tokens += 1;
  const pathname = vaultPath(folder, added.product.id, tokens.toString(16).padStart(16, "0"), "guide.pdf");
  objects.set(pathname, 10 * 1024 * 1024);
  const file: ProductFile = { pathname, name: "guide.pdf", bytes: 10 * 1024 * 1024, contentType: "application/pdf", addedAt: "2026-06-01T00:00:00.000Z" };
  const put = await setProductFile(email, added.product.id, file);
  if (!put.ok) throw new Error(`no file: ${put.reason}`);
  await setSubscription(email, { active: false });
  const ended = Date.parse((await storeForEmail(email))?.planEndedAt ?? "");
  return { email, handle, folder, ended };
}

/** Its three notices, as the daily run sends them, so its closing day can come. */
async function told(made: Made): Promise<void> {
  for (const at of [made.ended + 60_000, made.ended + M * DAY, made.ended + W * DAY]) await closeOne(made.email, at, hands);
}

const filesOf = (made: Made) => [...objects.keys()].filter((path) => path.startsWith(`vault/${made.folder}/`)).length;
const inLine = async (made: Made) => (await redis.pipeline([["ZSCORE", DUE_KEY, made.email]]))[0] !== null;
const closingFinal = async (made: Made) => (await redis.pipeline([["ZSCORE", FINAL_INDEX, made.email]]))[0] !== null;
const record = async (made: Made): Promise<Record<string, unknown> | null> => {
  const [raw] = await redis.pipeline([["GET", stateKey(made.email)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const real = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = real;
  }
}

const realNow = Date.now.bind(Date);
const clockAt = (ms: number) => {
  const shift = ms - realNow();
  Date.now = () => realNow() + shift;
};

async function main(): Promise<void> {
  redis.clear();
  // A plan that ends from 18 October 2026 closes its store; one before 31 October has no buyers' notice.
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY],
    ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"],
    ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;

  const mute = await closingStore("mutestore");
  const back = await closingStore("backstore");
  const alive = await closingStore("alivestore");
  const late = await closingStore("latestore");
  const renew = await closingStore("renewstore");
  for (const made of [mute, back, alive, late, renew]) await told(made);
  is("every store was told three times", sent.length, 15);

  part("Stripe silent from the closing day until the deadline");
  platform = "down";
  const firstDay = await quietly(() => closeOne(mute.email, mute.ended + (C + 1) * DAY, hands));
  is("on its day Stripe cannot be asked: held, nothing removed", [firstDay.state, firstDay.note, filesOf(mute), await inLine(mute)], ["held", "Stripe could not be asked", 1, false]);
  const lastHeld = await quietly(() => closeOne(mute.email, mute.ended + (C + SILENT) * DAY - 60_000, hands));
  is("a minute before the deadline it is still held, nothing removed (never before the deadline)", [lastHeld.state, filesOf(mute), await inLine(mute)], ["held", 1, false]);
  const budget = await quietly(() => closeOne(mute.email, mute.ended + (C + SILENT + 1) * DAY, hands, Number.POSITIVE_INFINITY, async () => false));
  is("past it, a store not asked at all today (the daily budget) is not taken for a silent one", [budget.state, budget.note, filesOf(mute)], ["held", "daily-recheck-budget", 1]);
  const lapsed = await quietly(() => closeOne(mute.email, mute.ended + (C + SILENT + 1) * DAY, hands));
  is("past the deadline, still silent: the store closes without Stripe", [lapsed.state, lapsed.lapsed], ["removed", true]);
  is("its files are gone, it is in line for the walk, and its closing is seen through", [filesOf(mute), await inLine(mute), await closingFinal(mute)], [0, true, true]);
  is("the case is written down on its closing record", typeof (await record(mute))?.lapsed, "number");
  is("nothing was changed at Stripe for it", posted.length, 0);

  part("Stripe silent on the closing day's own steps");
  // A late plan's check (its closing day began, then the file store failed, then Stripe went silent).
  platform = "up";
  fileStore = "down";
  const started = await quietly(() => closeOne(late.email, late.ended + (C + 1) * DAY, hands));
  is("its day begins and is held on the file store", [started.state, await closingFinal(late), filesOf(late)], ["held", true, 1]);
  fileStore = "up";
  platform = "down";
  const checking = await quietly(() => closeOne(late.email, late.ended + (C + 2) * DAY, hands));
  is("then a late plan cannot be checked: held", [checking.state, checking.note, filesOf(late)], ["held", "its plan subscriptions could not all be checked", 1]);
  const lateGone = await quietly(() => closeOne(late.email, late.ended + (C + SILENT + 1) * DAY, hands));
  is("past the deadline it closes without Stripe, written down", [lateGone.state, lateGone.lapsed, filesOf(late), await inLine(late), typeof (await record(late))?.lapsed], ["removed", true, 0, true, "number"]);
  // Its renewals (the creator's connected account is silent, the platform answers).
  platform = "up";
  await setStripeAccount(renew.email, "acct_1SilentLapse01");
  connected = "down";
  const renewDay = await quietly(() => closeOne(renew.email, renew.ended + (C + 1) * DAY, hands));
  is("its renewals cannot be stopped: held", [renewDay.state, renewDay.note, filesOf(renew)], ["held", "Stripe could not be asked to stop its renewals", 1]);
  const renewGone = await quietly(() => closeOne(renew.email, renew.ended + (C + SILENT + 1) * DAY, hands));
  is("past the deadline it closes without Stripe, written down", [renewGone.state, renewGone.lapsed, filesOf(renew), await inLine(renew), typeof (await record(renew))?.lapsed], ["removed", true, 0, true, "number"]);
  connected = "up";

  part("Stripe that answers before the deadline: the ordinary closing");
  platform = "down";
  const backHeld = await quietly(() => closeOne(back.email, back.ended + (C + 1) * DAY, hands));
  is("held while it is silent", backHeld.state, "held");
  platform = "up";
  const backGone = await quietly(() => closeOne(back.email, back.ended + (C + 3) * DAY, hands));
  is("it answers that no plan runs: closed as always, nothing written down as lapsed", [backGone.state, backGone.lapsed, filesOf(back), await inLine(back), (await record(back))?.lapsed], ["removed", undefined, 0, true, undefined]);

  part("Stripe that answers after the deadline, that the plan runs");
  platform = "down";
  await quietly(() => closeOne(alive.email, alive.ended + (C + 1) * DAY, hands));
  platform = "up";
  running.set(alive.handle, { id: `sub_${alive.handle}0001`, object: "subscription", status: "active", customer: `cus_${alive.handle}0001`, metadata: { store: alive.handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } }, current_period_end: Math.floor((alive.ended + 60 * DAY) / 1000) }] }, current_period_end: Math.floor((alive.ended + 60 * DAY) / 1000) });
  const aliveAfter = await quietly(() => closeOne(alive.email, alive.ended + (C + SILENT + 1) * DAY, hands));
  is("the store runs: the deadline replaces a hold, never an answer", [aliveAfter.state, filesOf(alive), await inLine(alive), aliveAfter.lapsed], ["running", 1, false, undefined]);

  part("The walk: personal records go, the dated record stays");
  const walked = await quietly(() => eraseClosed(Date.now() + 20_000, finishClosed, renew.ended + (C + SILENT + 1) * DAY + 3_600_000));
  is("the walk deletes the four closed stores", [walked.done, walked.finished, ...(await Promise.all([mute, late, renew, back].map(async (made) => (await storeForEmail(made.email))?.handle ?? null)))], [true, 4, null, null, null, null]);
  is("the store that runs stays", (await storeForEmail(alive.email))?.handle, alive.handle);
  for (const made of [mute, late, renew]) {
    const kept = await record(made);
    const values = Object.values(kept ?? {});
    is(`${made.handle}: only dates are left, the case and the deletion among them`, [values.length > 0 && values.every((value) => typeof value === "number"), typeof kept?.lapsed, typeof kept?.erased], [true, "number", "number"]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
