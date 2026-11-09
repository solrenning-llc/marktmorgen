/**
 * A closed store whose Stripe never answers (DONO-3), fourth pre-review of claude5/closed-store-deadline.
 *
 * P1-P3 are that review's proof (scratchpad prerev-closed-store-deadline-r4-proof), copied as they are:
 *   - P1: refusals count "in a row" only when seen on runs no more than REFUSAL_GAP apart; one fresh refusal after
 *     weeks in which the account was not asked starts the count again, never lapses at once;
 *   - P2: a store with no plan subscription id cannot have our key confirmed through it, and is never reported as
 *     our key refused ("other");
 *   - P3: a key of another account for weeks: never deleted, counted as "key".
 * Added: distinct creator accounts refusing together (Connect suspended for the whole platform, or account ids of
 * ours gone wrong) are never a creator's choice: such refusals keep every store, as "key", never deleted.
 */
import { createHash } from "node:crypto";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { savePaidPeriod } from "@/lib/closing-holds";
import * as heldStores from "@/lib/held-stores";
import { companyMonthlyMarginReportWithHeld } from "@/lib/company-margin-report";
import { CLOSING_DAYS, ERASE_EVERY_DAYS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { addProduct, claimHandle, setProductFile, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { vaultPath } from "@/lib/vault-rules";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { paidPeriods } from "@/lib/closing-holds";
import { stripeSilent } from "@/lib/stripe-silence";
import { onPlatform } from "@/lib/billing";
import { withCutoff } from "@/lib/fetch-timeout";
import { creditKey } from "@/lib/closing-credit";
import { readPaidInvoice } from "@/lib/charge-check-read";
import { StripeUnreadableReply } from "@/lib/stripe-http-error";
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
// Never down here; kept as the other tests have it.
const fileStore = "up" as "up" | "down";
/** Stripe, as the platform (plans) and as the creators' connected accounts (what they sold). */
let platform: "up" | "down" | "html502" | "key401" | "slow" = "up";
const resendDown = false;
let connected: "up" | "down" | "revoked" = "up";
const running = new Map<string, Record<string, unknown>>();
/** Ended plan subscriptions the platform reads by id only (never in a search): a store's own, so our key is confirmed. */
const ownPlans = new Map<string, Record<string, unknown>>();
const posted: string[] = [];
/** What the creators' connected accounts were asked, by path. */
const asked: string[] = [];
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
    if (onAccount && connected === "revoked") return json({ error: { type: "invalid_request_error", code: "account_invalid", message: "The provided key does not have access to account (or that account does not exist). Application access may have been revoked." } }, 403);
    if (!onAccount && platform === "html502") return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
    if (!onAccount && platform === "key401") return json({ error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_live_****" } }, 401);
    if (!onAccount && platform === "slow") await new Promise((r) => setTimeout(r, 1000));
    if (method !== "GET") posted.push(`${method} ${url.pathname}`);
    if (onAccount) asked.push(url.pathname);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/subscriptions/search") {
      const query = url.searchParams.get("query") ?? "";
      return json({ object: "search_result", data: [...running.entries()].filter(([handle]) => query.includes(`'${handle}'`)).map(([, row]) => row), has_more: false, next_page: null });
    }
    if (path === "/subscriptions") return json({ object: "list", data: [], has_more: false });
    if (path === "/checkout/sessions" && method === "GET") return json({ object: "list", data: [], has_more: false });
    const one = [...running.values(), ...ownPlans.values()].find((row) => path === `/subscriptions/${String(row.id)}`);
    if (one) return json(one);
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }
  if (url.hostname === "api.resend.com") {
    if (resendDown) return json({ message: "down (stand-in)" }, 500);
    // One email, or a batch of them (lib/closing-buyers.ts sends its members' notices as one batch).
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string } | { to: string[]; subject: string }[];
    const mails = Array.isArray(body) ? body : [body];
    sent.push(...mails);
    return json(Array.isArray(body) ? { data: mails.map((_, i) => ({ id: `email-${sent.length - mails.length + i + 1}` })) } : { id: `email-${sent.length}` });
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




async function errorOf(work: () => Promise<unknown>): Promise<unknown> { try { await work(); return null; } catch (e) { return e; } }

async function main(): Promise<void> {
  redis.clear();
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY], ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"], ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  part("PROOF P1: two refusals SILENT days apart, the account never asked in between, lapse at once (not 'in a row')");
  const g = await closingStore("gapclock");
  await told(g);
  await setStripeAccount(g.email, "acct_1GapClock000001");
  const gs = await storeForEmail(g.email);
  if (!gs) throw new Error("no store");
  await savePaidPeriod(gs, "sub_gapclock000001", { inv: "in_gapclock000001", amt: 6000, cur: "usd", ps: Math.floor((g.ended - 10 * DAY) / 1000), pe: Math.floor((g.ended + 50 * DAY) / 1000), e: "gap-member@example.com" });
  ownPlans.set(g.handle, { id: `sub_${g.handle}0001`, object: "subscription", status: "canceled", customer: `cus_${g.handle}0001`, metadata: { store: g.handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } } }] } });
  connected = "revoked";
  const a1 = await quietly(() => closeOne(g.email, g.ended + (C + 1) * DAY, hands));
  const from1 = (await record(g))?.refusedFrom;
  // The creator reconnects; our platform key is refused for the following weeks, so the account is never asked.
  connected = "up";
  platform = "key401";
  for (let d = 2; d <= SILENT; d += 1) await quietly(() => closeOne(g.email, g.ended + (C + d) * DAY, hands));
  const from2 = (await record(g))?.refusedFrom;
  // Key fixed; the creator disconnected again YESTERDAY: one refusal today.
  platform = "up";
  connected = "revoked";
  const a2 = await quietly(() => closeOne(g.email, g.ended + (C + SILENT + 1) * DAY, hands));
  is("refusedFrom written at the first refusal and kept through the weeks nobody asked", [a1.state, typeof from1, from1 === from2], ["held", "number", true]);
  is("one fresh refusal after weeks without asking must not lapse at once", [a2.state, filesOf(g)], ["held", 1]);
  connected = "up";

  part("PROOF P2: a closing store with no plan subscription id, creator disconnected, our key fine: counted as 'key' for ever");
  const n = await closingStore("nosubid");
  await setSubscription(n.email, { subscriptionId: null });
  await told(n);
  await setStripeAccount(n.email, "acct_1NoSubId0000001");
  connected = "revoked";
  const later = n.ended + (C + ERASE_WITHIN_DAYS + 5) * DAY;
  let last: Awaited<ReturnType<typeof closeOne>> | null = null;
  for (const d of [1, 2, SILENT + 1, ERASE_WITHIN_DAYS + 5]) last = await quietly(() => closeOne(n.email, n.ended + (C + d) * DAY, hands, Number.POSITIVE_INFINITY, async () => true));
  const sn = await storeForEmail(n.email);
  const monthN = new Date(later).toISOString().slice(0, 7);
  const idN = "held_" + sha(n.email);
  const [marksN] = await redis.pipeline([["HMGET", "nl:held:month:" + monthN, "over:key:" + idN]]);
  is("store has no subscription id (precondition)", sn?.subscriptionId ?? null, null);
  is("our key works (platform up): never reported as 'chave do Stripe recusada'", [last?.state, last?.overdue, marksN], ["held", "other", [null]]);
  connected = "up";
  part("CHECK P3: a wrong key (another account) for SILENT+10 days in a row: never deleted, counted as 'key'");
  const w = await closingStore("wrongforlong");
  await told(w);
  await setStripeAccount(w.email, "acct_1WrongLong00001");
  const ws = await storeForEmail(w.email);
  if (!ws) throw new Error("no store");
  await savePaidPeriod(ws, "sub_wronglong00001", { inv: "in_wronglong00001", amt: 6000, cur: "usd", ps: Math.floor((w.ended - 10 * DAY) / 1000), pe: Math.floor((w.ended + 50 * DAY) / 1000), e: "wl-member@example.com" });
  connected = "revoked"; // platform "up" but no ownPlans entry: the platform answers 404 for the store's own subscription
  const wb = sent.length;
  let wr: Awaited<ReturnType<typeof closeOne>> | null = null;
  for (let d = 1; d <= SILENT + 10; d += 1) wr = await quietly(() => closeOne(w.email, w.ended + (C + d) * DAY, hands));
  is("held, files kept, nobody told, reason key", [wr?.state, filesOf(w), sent.slice(wb).filter((x) => x.to.includes("wl-member@example.com")).length, wr?.overdue], ["held", 1, 0, "key"]);
  connected = "up";

  part("Distinct accounts refusing together are ours, not the creators': kept as 'key', never deleted");
  const many = [await closingStore("manyone"), await closingStore("manytwo"), await closingStore("manythree")];
  for (const [i, made] of many.entries()) {
    await told(made);
    await setStripeAccount(made.email, `acct_1ManyRefused0${i}0`);
    ownPlans.set(made.handle, { id: `sub_${made.handle}0001`, object: "subscription", status: "canceled", customer: `cus_${made.handle}0001`, metadata: { store: made.handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } } }] } });
  }
  connected = "revoked";
  const base = Math.max(...many.map((made) => made.ended));
  let lastMany: Awaited<ReturnType<typeof closeOne>>[] = [];
  for (let d = 1; d <= SILENT + 1; d += 1) {
    lastMany = [];
    for (const made of many) lastMany.push(await quietly(() => closeOne(made.email, base + (C + d) * DAY, hands)));
  }
  is("three accounts refusing every day for the whole time: all kept, files kept", [lastMany.map((r) => r.state), many.map(filesOf)], [["held", "held", "held"], [1, 1, 1]]);
  const laterMany = await quietly(() => closeOne(many[0].email, base + (C + ERASE_WITHIN_DAYS + 1) * DAY, hands));
  is("and past the published time it is reported as our key's", [laterMany.state, laterMany.overdue], ["held", "key"]);
  connected = "up";
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
