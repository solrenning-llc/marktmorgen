/**
 * Claude 6's N1 on #3463 (12292095): the refund step never fed Stripe's silence or refusal into the closing's count.
 * giveBackUnused turned a balance read or a refund call that failed into `failed` rows, and closingSteps held on
 * them with no streak, so a store whose renewals were stopped and whose creator account then went quiet, or
 * disconnected, never closed by its deadline: its members' owed refunds stayed undecided and untold, and its data
 * was kept with no end. Now the refund step says what failed and whether the account answered: silence and refusal
 * count there with the same streak, together and platform guards as in the renewals step, and an answer from the
 * account starts the count again.
 */
import { createHash } from "node:crypto";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { savePaidPeriod } from "@/lib/closing-holds";
import { creditKey } from "@/lib/closing-credit";
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
  objects.clear();
  ownPlans.clear();
  running.clear();
  sent.length = 0;
  platform = "up";
  connected = "up";
  broken.clear();
}

const renewalNotices = (made: Made) => sent.filter((mail) => mail.to.includes(`${made.handle}-member@example.com`) && /may keep renewing/i.test(mail.subject));

const refundLetters = (made: Made) => sent.filter((mail) => mail.to.includes(`${made.handle}-member@example.com`) && /may not have been made/i.test(mail.subject));

async function main(): Promise<void> {
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY], ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"], ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  for (const [how, label] of [["down", "silent"], ["revoked", "refusing us (403 account_invalid)"]] as const) {
    part(`Renewals stopped, then the creator's account ${label} on the refund step: closes at its deadline, members told`);
    fresh();
    const a = await withMember(`refund${how}`, how === "down" ? "acct_1RefundQuiet01" : "acct_1RefundGone01");
    // The closing day: renewals are stopped, the balance read is the first to fail.
    broken.set("/v1/balance", how);
    const first = await quietly(() => closeOne(a.email, a.ended + (C + 1) * DAY, hands));
    is("day C+1: renewals stopped, the refunds held", [first.state, typeof (await record(a))?.renewals], ["held", "number"]);
    await redis.pipeline([["SET", creditKey(a.folder), 5]]);
    connected = how;
    let gone = -1;
    for (let d = C + 2; d <= C + SILENT + 3 && gone < 0; d += 1) if ((await quietly(() => closeOne(a.email, a.ended + d * DAY, hands))).state === "removed") gone = d - C;
    is("closed without Stripe within a day of its deadline, never before it", gone >= SILENT && gone <= SILENT + 2, true);
    is("its files are gone and the case is written down", [filesOf(a), typeof (await record(a))?.lapsed], [0, "number"]);
    is("its member was told the refund may not have been made, before it closed", refundLetters(a).length, 1);
  }

  part("An answer from the account on the refund step starts the count again");
  fresh();
  const b = await withMember("refundback", "acct_1RefundBack01");
  broken.set("/v1/balance", "down");
  await quietly(() => closeOne(b.email, b.ended + (C + 1) * DAY, hands));
  await redis.pipeline([["SET", creditKey(b.folder), 5]]);
  connected = "down";
  for (let d = C + 2; d <= C + 4; d += 1) await quietly(() => closeOne(b.email, b.ended + d * DAY, hands));
  // Day C+5: the account answers its balance, but the payment's read gives no answer.
  connected = "up";
  broken.clear();
  broken.set("/v1/payment_intents", "down");
  await quietly(() => closeOne(b.email, b.ended + (C + 5) * DAY, hands));
  connected = "down";
  let removedAt = -1;
  for (let d = C + 6; d <= C + 14 && removedAt < 0; d += 1) if ((await quietly(() => closeOne(b.email, b.ended + d * DAY, hands))).state === "removed") removedAt = d - C;
  is("not closed on the old count: no sooner than STRIPE_SILENT_DAYS after the answer", removedAt === -1 || removedAt >= 5 + SILENT, true);
  is("but closed on the new one", removedAt > 0, true);

  // Claude 1's review 6799408486 of #3463 (MEDIUM): only the creator account's subscription search gave no answer; its
  // balance and the rest of the account answered on every run. The renewals step lapsed on that silence and the
  // refund step's answer did not undo it, so on C+8 the store was removed as lapsed, its renewals never stopped.
  part("The renewals search silent while the account answers its balance: never closed as lapsed");
  fresh();
  const c = await withMember("searchquiet", "acct_1SearchQuiet01");
  await redis.pipeline([["SET", creditKey(c.folder), 5]]);
  broken.set("/v1/subscriptions/search", "down");
  let closedAt = -1;
  for (let d = C + 1; d <= C + SILENT + 3 && closedAt < 0; d += 1) if ((await quietly(() => closeOne(c.email, c.ended + d * DAY, hands))).state === "removed") closedAt = d - C;
  is("never removed while the account answers on the same run", closedAt, -1);
  is("nothing written down as lapsed", (await record(c))?.lapsed, undefined);
  is("its member is not told renewals may continue, nor that the refund may not have been made", [renewalNotices(c).length, refundLetters(c).length], [0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
