/**
 * Claude 3's review of #3463 (H1 ALTO, M2 MÉDIO), confirmed by Codex U: Stripe's silence about a closing store
 * lapsed on the first silent answer seen at or after its deadline, with none of the refusal path's guards, so a
 * transient failure of ours or Stripe's (our egress, a Stripe incident, a store not asked for days) closed and
 * erased the store, its members' renewals unstopped; and those members were never told that they may keep
 * being charged. Now silence has the refusal's shape:
 *
 *   - it lapses only after STRIPE_SILENT_DAYS of silence on runs no more than REFUSAL_GAP_MS apart (silentFrom /
 *     silentLast, cleared by any answer), and never before the deadline;
 *   - only while our platform key reads the store's own subscription in the same run (a platform that is silent
 *     too is ours: held);
 *   - never while several creator accounts are silent together;
 *   - and before anything is deleted, each member whose renewals were not stopped is told that the membership may
 *     keep renewing and how to stop it; a notice that cannot go out holds the store.
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
}

const renewalNotices = (made: Made) => sent.filter((mail) => mail.to.includes(`${made.handle}-member@example.com`) && /may keep renewing/i.test(mail.subject));

async function main(): Promise<void> {
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY], ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"], ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  part("The creator's account silent on every daily run from the closing day: closes at its deadline, its members told first");
  fresh();
  // Its member's paid time ends before the closing day: no refund is owed, only the renewal notice.
  const a = await withMember("dailysilent", "acct_1DailySilent001", false);
  connected = "down";
  for (let d = C + 1; d <= C + SILENT; d += 1) {
    const r = await quietly(() => closeOne(a.email, a.ended + d * DAY, hands));
    if (r.state !== "held") is(`day ${d}: held`, r.state, "held");
  }
  is("before the deadline: held every day, nothing removed, nobody told it may renew", [filesOf(a), renewalNotices(a).length], [1, 0]);
  // Out of the closing's email credit (lib/closing-credit.ts): the member cannot be told, so nothing is deleted.
  await redis.pipeline([["SET", creditKey(a.folder), 0]]);
  const unsent = await quietly(() => closeOne(a.email, a.ended + (C + SILENT + 1) * DAY, hands));
  is("at the deadline, the renewal notice cannot go out: held, nothing removed", [unsent.state, unsent.note, filesOf(a)], ["held", "its members whose renewals were not stopped are not all told yet", 1]);
  await redis.pipeline([["SET", creditKey(a.folder), 5]]);
  const gone = await quietly(() => closeOne(a.email, a.ended + (C + SILENT + 1) * DAY + 3_600_000, hands));
  is("then it closes without Stripe", [gone.state, gone.lapsed, filesOf(a)], ["removed", true, 0]);
  is("its member was told the membership may keep renewing, once", renewalNotices(a).length, 1);
  is("the notice says how to stop it and that it closed", /contact|card/i.test(String((renewalNotices(a)[0] as { text?: string } | undefined)?.text ?? "")), true);

  part("Silence seen once after days not asked (missed runs): the count starts again, held");
  fresh();
  const b = await withMember("gapsilent", "acct_1GapSilent0001");
  connected = "down";
  is("day C+1: held", (await quietly(() => closeOne(b.email, b.ended + (C + 1) * DAY, hands))).state, "held");
  const late = await quietly(() => closeOne(b.email, b.ended + (C + SILENT + 2) * DAY, hands));
  is("first silence after the gap, past the deadline: held, nothing removed", [late.state, filesOf(b), typeof (await record(b))?.lapsed], ["held", 1, "undefined"]);

  part("The closing record stays in the shape main reads it in: every field a number, buyersAfter the only text");
  // lib/plan-closing.ts readState on main (CX-123 rule 24) refuses any other field as an unknown reply, so a reason
  // kept as text (`overdueWhy`) made every store held past its published time unreadable once merged.
  // The store whose count started again: still silent, now past its published time, so it is counted with a reason.
  const past = await quietly(() => closeOne(b.email, b.ended + (C + ERASE_WITHIN_DAYS + 2) * DAY, hands));
  is("held past its published time, with a reason", [past.state, typeof past.overdue], ["held", "string"]);
  const kept = await record(b);
  is("a store held past its published time keeps why, as a number", Object.entries(kept ?? {}).filter(([name, value]) => name === "buyersAfter" ? typeof value !== "string" : typeof value !== "number" || !Number.isFinite(value)).map(([name]) => name), []);
  is("…and it was kept", typeof (kept as Record<string, unknown> | null)?.overdueAs, "number");

  part("A platform outage too (our key silent in the same run): ours, held every day");
  fresh();
  const c = await withMember("outagesilent", "acct_1OutageSilent01");
  connected = "down";
  platform = "down";
  let removed = 0;
  for (let d = C + 1; d <= C + SILENT + 2; d += 1) if ((await quietly(() => closeOne(c.email, c.ended + d * DAY, hands))).state === "removed") removed += 1;
  is("never removed while the platform is silent too", [removed, filesOf(c)], [0, 1]);

  part("Several creator accounts silent together: ours, held");
  fresh();
  const many = [await withMember("togethera", "acct_1TogetherA0001"), await withMember("togetherb", "acct_1TogetherB0001"), await withMember("togetherc", "acct_1TogetherC0001")];
  connected = "down";
  removed = 0;
  for (let d = C + 1; d <= C + SILENT + 2; d += 1) for (const made of many) if ((await quietly(() => closeOne(made.email, made.ended + d * DAY, hands))).state === "removed") removed += 1;
  is("none removed", [removed, ...many.map(filesOf)], [0, 1, 1, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
