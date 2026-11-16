/**
 * A member already told of a store's closing (its notice took EMAILS_PER_BUYER_PER_ENDING of the closing's email
 * credit: the notice and ONE follow-up) never gets a follow-up letter the closing did not pay for (Claude 1 cloud's
 * quality review 6818917422 of #3463, MEDIUM; rule MR: a cap before every spend).
 *
 * Before: a store closed without Stripe at its deadline, its renewals not stopped, sent such a member two follow-ups,
 * "Your refund ... may not have been made" and "Your membership ... may keep renewing", neither taking credit; a member
 * with two subscriptions got one refund letter for each; and a member already sent the "balance did not cover it"
 * letter was sent the renewals letter too, on the company sender, with no credit taken. Now the refund and the
 * renewals go in one letter, one letter an address, and any letter past a told member's one funded follow-up takes a
 * credit first: none left, nothing is sent and the store is held (as "notice"), never sent unpaid.
 */
import { type Hands, closeOne } from "@/lib/plan-closing";
import { savePaidPeriod } from "@/lib/closing-holds";
import { creditKey } from "@/lib/closing-credit";
import { toldKey } from "@/lib/closing-buyers";
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

// ------------------------------------------------------------- stand-ins

/** The file store, by path. */
const objects = new Map<string, number>();
// Never down here; kept as the other tests have it.
const fileStore = "up" as "up" | "down";
/** Stripe, as the platform (plans) and as the creators' connected accounts (what they sold). */
let platform: "up" | "down" | "html502" | "key401" | "slow" = "up";
const resendDown = false;
let connected: "up" | "down" | "revoked" = "up";
/** Paths of the creator's account (by prefix) that give no answer or refuse, while the rest answers. */
const broken = new Map<string, "down" | "revoked">();
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
    // One path of the creator's account given no answer, or refused, while the rest answers.
    const partly = onAccount ? [...broken].find(([prefix]) => url.pathname.startsWith(prefix)) : undefined;
    if (partly?.[1] === "down") throw new TypeError("fetch failed");
    if (partly?.[1] === "revoked") return json({ error: { type: "invalid_request_error", code: "account_invalid", message: "The provided key does not have access to account (or that account does not exist). Application access may have been revoked." } }, 403);
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
    // The creator's account's balance, read before any refund is weighed.
    if (onAccount && path === "/balance") return json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }], pending: [] });
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




/** A closing store with a creator account and one member with a known subscription, its own plan read by our key. */
async function withMember(handle: string, account: string, unused = true): Promise<Made> {
  const made = await closingStore(handle);
  await told(made);
  await setStripeAccount(made.email, account);
  const s = await storeForEmail(made.email);
  if (!s) throw new Error("no store");
  await savePaidPeriod(s, `sub_${handle}m00001`, { inv: `in_${handle}m00001`, amt: 6000, cur: "usd", ps: Math.floor((made.ended - 10 * DAY) / 1000), pe: Math.floor((made.ended + (unused ? 50 : 1) * DAY) / 1000), e: `${handle}-member@example.com` });
  ownPlans.set(handle, { id: `sub_${handle}0001`, object: "subscription", status: "canceled", customer: `cus_${handle}0001`, metadata: { store: handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } } }] } });
  return made;
}

function fresh(): void {
  redis.clear();
  creditTaken.clear();
  objects.clear();
  ownPlans.clear();
  running.clear();
  sent.length = 0;
  platform = "up";
  connected = "up";
  broken.clear();
}




const member = (made: Made, n = "") => `${made.handle}-member${n}@example.com`;
const lettersTo = (address: string) => sent.filter((mail) => mail.to.includes(address));
/** Credit taken from each closing's email credit, net of what was given back (DECRBY less INCRBY on its key). */
const creditTaken = new Map<string, number>();
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const [name, key, n] of commands) {
    const op = String(name).toUpperCase();
    if ((op === "DECRBY" || op === "INCRBY") && String(key).startsWith("nl:closing:credit:")) creditTaken.set(String(key), (creditTaken.get(String(key)) ?? 0) + (op === "DECRBY" ? 1 : -1) * Number(n));
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
/** The credit taken from this store's closing since `fresh()`, kept after the store's credit key is deleted. */
const creditUsed = (made: Made) => creditTaken.get(creditKey(made.folder)) ?? 0;
const markTold = async (made: Made, address: string) => {
  await redis.pipeline([["HSET", toldKey(made.folder), address, String(made.ended)]]);
};
/** Daily runs from C+1 with the creator's account giving no answer; the day it was removed after C, or -1. */
async function silentUntilRemoved(made: Made, from = C + 1, to = C + SILENT + 3): Promise<number> {
  connected = "down";
  for (let d = from; d <= to; d += 1) if ((await quietly(() => closeOne(made.email, made.ended + d * DAY, hands))).state === "removed") return d - C;
  return -1;
}

async function main(): Promise<void> {
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY], ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"], ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  part("A told member, the closing out of credit, closed without Stripe before its renewals stopped: one letter, unpaid by nothing");
  fresh();
  const a = await withMember("toldlapse", "acct_1ToldLapse001");
  await markTold(a, member(a));
  await redis.pipeline([["SET", creditKey(a.folder), 0]]);
  const goneA = await silentUntilRemoved(a);
  is("closed at its deadline", goneA >= SILENT && goneA <= SILENT + 2, true);
  const toA = lettersTo(member(a));
  is("its member got exactly one follow-up, its one the closing paid for", toA.length, 1);
  is("which says the refund may not have been made", /may not have been made/i.test(toA[0]?.subject ?? ""), true);
  is("and that the membership may keep renewing", /may keep renewing/i.test(toA[0]?.subject ?? ""), true);
  is("no credit was taken for it", creditUsed(a), 0);

  part("A told member with two subscriptions: one letter for both, not one a subscription");
  fresh();
  const b = await withMember("toldtwice", "acct_1ToldTwice001");
  const sb = (await storeForEmail(b.email))!;
  await savePaidPeriod(sb, "sub_toldtwicem00002", { inv: "in_toldtwicem00002", amt: 3000, cur: "usd", ps: Math.floor((b.ended - 10 * DAY) / 1000), pe: Math.floor((b.ended + 50 * DAY) / 1000), e: member(b) });
  await markTold(b, member(b));
  await redis.pipeline([["SET", creditKey(b.folder), 0]]);
  const goneB = await silentUntilRemoved(b);
  is("closed at its deadline", goneB >= SILENT && goneB <= SILENT + 2, true);
  is("its member got one letter", lettersTo(member(b)).length, 1);
  is("no credit was taken for it", creditUsed(b), 0);

  part("A told member already sent its follow-up (the balance did not cover the refund): the renewals letter takes a credit");
  fresh();
  const c = await withMember("toldshort", "acct_1ToldShort001");
  const sc = (await storeForEmail(c.email))!;
  // Its one subscription's refund was told short on an earlier run: settled (f), and its follow-up sent (m).
  await savePaidPeriod(sc, "sub_toldshortm00001", { inv: "in_toldshortm00001", amt: 6000, cur: "usd", ps: Math.floor((c.ended - 10 * DAY) / 1000), pe: Math.floor((c.ended + 50 * DAY) / 1000), e: member(c), r: "short", f: 1, want: 5000, m: 1 });
  await markTold(c, member(c));
  await redis.pipeline([["SET", creditKey(c.folder), 0]]);
  const heldC = await silentUntilRemoved(c);
  is("out of credit: never removed with its member's renewals letter unpaid", heldC, -1);
  is("and no letter sent to it unpaid", lettersTo(member(c)).length, 0);
  await redis.pipeline([["SET", creditKey(c.folder), 1]]);
  const goneC = await silentUntilRemoved(c, C + SILENT + 4, C + SILENT + 6);
  is("with one credit: removed", goneC > 0, true);
  const toC = lettersTo(member(c));
  is("its member told the renewals may continue, once", toC.length === 1 && /may keep renewing/i.test(toC[0]?.subject ?? ""), true);
  is("that letter took the one credit", creditUsed(c), 1);

  part("Control: a member never told takes one credit for its one letter");
  fresh();
  const d = await withMember("untoldlapse", "acct_1UntoldLapse01");
  await redis.pipeline([["SET", creditKey(d.folder), 5]]);
  const goneD = await silentUntilRemoved(d);
  is("closed at its deadline", goneD >= SILENT && goneD <= SILENT + 2, true);
  is("one letter", lettersTo(member(d)).length, 1);
  is("one credit taken", creditUsed(d), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
