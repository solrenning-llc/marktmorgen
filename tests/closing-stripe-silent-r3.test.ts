/**
 * A closed store whose Stripe never answers (DONO-3), third pre-review of claude5/closed-store-deadline.
 *
 * Proofs (a) and (d) are that review's (scratchpad prerev-closed-store-deadline-r3-proof), copied as they are:
 *
 *   - (a) a platform key of another Stripe account makes every connected call answer 403 account_invalid, as a
 *     creator who disconnected does: one run must never delete for it. A 403 is silence only after
 *     STRIPE_SILENT_DAYS of 403s in a row (refusedFrom), and only when the platform reads this store's own
 *     subscription in the same run (our key is the right one); a platform that cannot find it is our key;
 *   - (d) one store kept for our key is counted under one reason a month, also when a run's recheck is denied;
 *   - a creator who did disconnect, with our key confirmed, lapses after those days, and the member's letter says
 *     the store's Stripe account could not be reached (not that Stripe did not answer);
 *   - an HTML page in front of Stripe is never a final "not found" for a charge check's invoice.
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

  part("PROOF (a): OUR misconfiguration (a valid key of another Stripe account / other mode) looks exactly like a creator who disconnected");
  // Our key revoked (401) for a month: held, counted as "key" (the coordinator's rule). Then the operator puts back a
  // WRONG key: a valid key of another Stripe account. Platform reads now answer 404 (no such subscription: another
  // account) and every connected call answers 403 account_invalid ("does not have access to account").
  const k = await closingStore("wrongkey");
  await told(k);
  await setStripeAccount(k.email, "acct_1WrongKeyShop1");
  const ks = await storeForEmail(k.email);
  if (!ks) throw new Error("no store");
  await savePaidPeriod(ks, "sub_wrongkey000001", { inv: "in_wrongkey000001", amt: 6000, cur: "usd", ps: Math.floor((k.ended - 10 * DAY) / 1000), pe: Math.floor((k.ended + 50 * DAY) / 1000), e: "wrongkey-member@example.com" });
  platform = "key401";
  for (const d of [1, 30]) await quietly(() => closeOne(k.email, k.ended + (C + d) * DAY, hands));
  platform = "up"; // the wrong account's key: platform answers 404 for our subscription ids
  connected = "revoked"; // and 403 account_invalid for every creator account
  const before = sent.length;
  const r = await quietly(() => closeOne(k.email, k.ended + (C + 31) * DAY, hands));
  const letters = sent.slice(before).filter((x) => x.to.includes("wrongkey-member@example.com"));
  is("ONE run with a wrong key must not delete a store nor tell its member the refund may not have been made", [r.state, filesOf(k), letters.length], ["held", 1, 0]);
  connected = "up";

  part("PROOF (d): one store held for our key (401) is counted under two reasons in one month when a run's recheck budget is spent");
  const q = await closingStore("twokinds");
  await told(q);
  platform = "key401";
  const t1 = q.ended + (C + ERASE_WITHIN_DAYS + 1) * DAY;
  const r1 = await quietly(() => closeOne(q.email, t1, hands, Number.POSITIVE_INFINITY, async () => true));
  const r2 = await quietly(() => closeOne(q.email, t1 + DAY, hands, Number.POSITIVE_INFINITY, async () => false));
  platform = "up";
  const monthQ = new Date(t1).toISOString().slice(0, 7);
  const sameMonth = monthQ === new Date(t1 + DAY).toISOString().slice(0, 7);
  const id = "held_" + sha(q.email);
  const [marks] = await redis.pipeline([["HMGET", "nl:held:month:" + monthQ, "over:key:" + id, "over:other:" + id]]);
  is("the same store, same month: counted once, under its real reason 'key'", [sameMonth, r1.overdue, r2.overdue, marks], [true, "key", "key", ["1", null]]);

  part("A creator who did disconnect, our key confirmed: 403s for STRIPE_SILENT_DAYS in a row lapse");
  const g = await closingStore("gonestore");
  await told(g);
  await setStripeAccount(g.email, "acct_1GoneStore00001");
  const gs = await storeForEmail(g.email);
  if (!gs) throw new Error("no store");
  await savePaidPeriod(gs, "sub_gonestore000001", { inv: "in_gonestore000001", amt: 6000, cur: "usd", ps: Math.floor((g.ended - 10 * DAY) / 1000), pe: Math.floor((g.ended + 50 * DAY) / 1000), e: "gone-member@example.com" });
  // The platform finds the store's own plan subscription (ended): our key is the right one.
  ownPlans.set(g.handle, { id: `sub_${g.handle}0001`, object: "subscription", status: "canceled", customer: `cus_${g.handle}0001`, metadata: { store: g.handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } } }] } });
  connected = "revoked";
  const g1 = await quietly(() => closeOne(g.email, g.ended + (C + 1) * DAY, hands));
  // Rule 23 (fourth pre-review, MÉDIO 1): refusals count in a row only when seen on daily runs, as the closing job
  // looks; the store is looked at every day, and the check a minute short of the days is the same.
  for (let d = 2; d < SILENT; d += 1) await quietly(() => closeOne(g.email, g.ended + (C + d) * DAY, hands));
  const g2 = await quietly(() => closeOne(g.email, g.ended + (C + SILENT) * DAY - 60_000, hands));
  is("refused from its day, and still a minute short of the days in a row: kept", [g1.state, g2.state, filesOf(g)], ["held", "held", 1]);
  const gBefore = sent.length;
  const g3 = await quietly(() => closeOne(g.email, g.ended + (C + SILENT + 1) * DAY, hands));
  const gLetter = sent.slice(gBefore).find((x) => x.to.includes("gone-member@example.com")) as { subject: string; text?: string } | undefined;
  is("then it lapses, its member told first", [g3.state, g3.lapsed, filesOf(g)], ["removed", true, 0]);
  is("the letter says the store's Stripe account could not be reached, not that Stripe did not answer", [/could not reach the store's Stripe account/.test(gLetter?.text ?? ""), /Stripe did not answer/.test(gLetter?.text ?? "")], [true, false]);
  connected = "up";

  part("An HTML page in front of Stripe is never a final 'not found' (charge checks)");
  const html404 = await readPaidInvoice({ get: async () => { throw new StripeUnreadableReply(404, new SyntaxError("not JSON")); }, id: "in_HtmlPage0001", until: Date.now() + 10_000, maxCalls: 3 });
  is("an HTML 404 is not answered, tried again later", ["reason" in html404 ? [html404.reason, html404.final] : null], [["not_answered", false]]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
