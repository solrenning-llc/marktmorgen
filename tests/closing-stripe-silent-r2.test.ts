/**
 * A closed store whose Stripe never answers (DONO-3), second pre-review of claude5/closed-store-deadline.
 *
 * Built from that review's proof (scratchpad prerev-closed-store-deadline-r2-proof, 15 of 19 failing on 61889c066f),
 * with the coordinator's decisions where the proof asked otherwise: Stripe refusing OUR key (401) and a member's
 * notice that cannot go out are not silence and never delete (rule 23); they keep the store, and every store kept
 * past the published time (ERASE_WITHIN_DAYS after its closing day) is counted in its month, by reason, for the
 * owner's report. What these hold:
 *
 *   - R1, R4: a 5xx served as HTML (a gateway's 502) is Stripe giving no answer, with its status kept;
 *   - R2: a request cut short by our own run's time is not Stripe's silence;
 *   - R3: our key refused (401): kept, counted past the published time as "key";
 *   - R5: one store that lapses is counted once, even when its record's save fails once;
 *   - R6: a member's paid time is never given up before the member is told; Stripe answering again first is the
 *     ordinary refund, never "not made";
 *   - R7: a notice that cannot go out keeps the store, counted as "notice"; so does a closing out of email credit;
 *   - R8: the creator disconnected Marktmorgen (403 account_invalid on the connected account): never answers again,
 *     so it lapses at the deadline like silence;
 *   - the lapse's letter says the day the store closed and that the refund may not have been made.
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
const fileStore: "up" | "down" = "up";
/** Stripe, as the platform (plans) and as the creators' connected accounts (what they sold). */
let platform: "up" | "down" | "html502" | "key401" | "slow" = "up";
const resendDown = false;
let connected: "up" | "down" | "revoked" = "up";
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
    if (onAccount && connected === "revoked") return json({ error: { type: "invalid_request_error", code: "account_invalid", message: "The provided key does not have access to account (or that account does not exist). Application access may have been revoked." } }, 403);
    if (!onAccount && platform === "html502") return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
    if (!onAccount && platform === "key401") return json({ error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_live_****" } }, 401);
    if (!onAccount && platform === "slow") await new Promise((r) => setTimeout(r, 1000));
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
  const realPipeline = redis.pipeline.bind(redis);
  let breakLapsedSave = "";
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
    if (breakLapsedSave && commands.some((c) => c[0] === "SET" && c[1] === breakLapsedSave && String(c[2]).includes('"lapsed"'))) {
      breakLapsedSave = "";
      throw new Error("redis timeout (stand-in)");
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;

  part("R1: a Stripe 5xx served as HTML (a gateway's 502) is classified");
  platform = "html502";
  const e502 = await errorOf(() => onPlatform("GET", "/subscriptions/sub_x0000001"));
  // Rule 23: the proof read the error's name as a placeholder ("BillingError?"); what matters is the status kept and silence.
  is("a 502 is silence per lib/stripe-silence.ts's own words (5xx); this one is", [Reflect.get(Object(e502), "status"), stripeSilent(e502)], [502, true]);
  platform = "slow";
  const eCut = await errorOf(() => withCutoff(Date.now() + 300, () => onPlatform("GET", "/subscriptions/sub_x0000001")));
  is("R2: a request cut short by OUR run's cutoff (Stripe would answer in 1 s, STRIPE_TIMEOUT_MS is 20 s) is not silence", stripeSilent(eCut), false);
  platform = "up";

  part("R3: platform key revoked (401) from the closing day on: is the store ever deleted?");
  const k = await closingStore("keystore");
  await told(k);
  platform = "key401";
  // Rule 23 (coordinator's decision, to go to Claude 1 and the owner): our own key refused is not Stripe's silence.
  // It never deletes; past the published time it is counted as "key".
  for (const d of [1, SILENT + 1, 30, 60, 400]) {
    const r = await quietly(() => closeOne(k.email, k.ended + (C + d) * DAY, hands));
    is(`day C+${d}: kept, and counted past the published time`, [d, r.state, filesOf(k), Reflect.get(r, "overdue")], [d, "held", 1, d >= ERASE_WITHIN_DAYS ? "key" : undefined]);
  }
  platform = "up";

  part("R4: a 5xx outage served as HTML from the closing day on");
  const h = await closingStore("htmlstore");
  await told(h);
  platform = "html502";
  const h1 = await quietly(() => closeOne(h.email, h.ended + (C + 1) * DAY, hands));
  const h2 = await quietly(() => closeOne(h.email, h.ended + (C + SILENT + 1) * DAY, hands));
  is("Stripe giving only 502s is silence: past the deadline the store closes without it", [h1.state, h2.state, filesOf(h)], ["held", "removed", 0]);
  platform = "up";

  part("R5: the lapse count is idempotent per store (count once) when the dated record's save fails once");
  const c = await closingStore("countstore");
  await told(c);
  await setStripeAccount(c.email, "acct_1SilentCount001");
  connected = "down";
  await quietly(() => closeOne(c.email, c.ended + (C + 1) * DAY, hands));
  breakLapsedSave = stateKey(c.email);
  const lapseDay = c.ended + (C + SILENT + 1) * DAY;
  const c1 = await quietly(() => closeOne(c.email, lapseDay, hands).catch((e) => ({ state: "threw", note: String(e) })));
  const c2 = await quietly(() => closeOne(c.email, lapseDay + 3_600_000, hands));
  connected = "up";
  const month = new Date(lapseDay).toISOString().slice(0, 7);
  const [cnt] = await redis.pipeline([["HGET", "nl:held:month:" + month, "lapsed"]]);
  is("one store that lapsed once is counted once", [c1.state, c2.state, Number(cnt)], ["threw", "removed", 1]);

  part("R6: A1 notice cannot go out on the lapse run (company postal address missing); next day Stripe and the address are back");
  const POSTAL = process.env.COMPANY_POSTAL_ADDRESS;
  const m = await closingStore("refundstore");
  await told(m);
  await setStripeAccount(m.email, "acct_1SilentRefund01");
  const ms = await storeForEmail(m.email);
  if (!ms) throw new Error("no store");
  await savePaidPeriod(ms, "sub_refund0000001", { inv: "in_refund0000001", amt: 6000, cur: "usd", ps: Math.floor((m.ended - 10 * DAY) / 1000), pe: Math.floor((m.ended + 50 * DAY) / 1000), e: "refund-member@example.com" });
  connected = "down";
  await quietly(() => closeOne(m.email, m.ended + (C + 1) * DAY, hands));
  delete process.env.COMPANY_POSTAL_ADDRESS;
  const m1 = await quietly(() => closeOne(m.email, m.ended + (C + SILENT + 1) * DAY, hands));
  const row = (await paidPeriods(ms)).get("sub_refund0000001");
  is("held because the notice did not go out", [m1.state, filesOf(m)], ["held", 1]);
  is("while held, the member's refund is not yet given up as final (Stripe may answer tomorrow)", [row?.r, row?.f], [undefined, undefined]);
  connected = "up";
  process.env.COMPANY_POSTAL_ADDRESS = POSTAL;
  const before = sent.length;
  const postedBefore = posted.length;
  const m2 = await quietly(() => closeOne(m.email, m.ended + (C + SILENT + 2) * DAY, hands));
  const unmade = sent.slice(before).filter((x) => x.to.includes("refund-member@example.com") && /not made automatically/.test(x.subject));
  is("Stripe answering again: the member is not told 'not made' without a refund being tried", [m2.state, unmade.length, posted.slice(postedBefore).filter((x) => x.includes("/refunds")).length > 0], [m2.state, 0, true]);

  part("R7: the company postal address never comes back: any exit before 400 days?");
  const n = await closingStore("mailstore");
  await told(n);
  await setStripeAccount(n.email, "acct_1SilentMail0001");
  const ns = await storeForEmail(n.email);
  if (!ns) throw new Error("no store");
  await savePaidPeriod(ns, "sub_mail00000001", { inv: "in_mail00000001", amt: 6000, cur: "usd", ps: Math.floor((n.ended - 10 * DAY) / 1000), pe: Math.floor((n.ended + 50 * DAY) / 1000), e: "mail-member@example.com" });
  connected = "down";
  await quietly(() => closeOne(n.email, n.ended + (C + 1) * DAY, hands));
  delete process.env.COMPANY_POSTAL_ADDRESS;
  // Rule 23 (coordinator's decision): a notice that cannot go out keeps the store; past the published time it is
  // counted as "notice".
  for (const d of [SILENT + 1, 60, 400]) {
    const r = await quietly(() => closeOne(n.email, n.ended + (C + d) * DAY, hands));
    is(`day C+${d}: kept until the member can be told, counted past the published time`, [d, r.state, filesOf(n), Reflect.get(r, "overdue")], [d, "held", 1, d >= ERASE_WITHIN_DAYS ? "notice" : undefined]);
  }
  process.env.COMPANY_POSTAL_ADDRESS = POSTAL; connected = "up";
  part("R8: the creator disconnected Marktmorgen from their Stripe account (403 account_invalid on every connected call)");
  const v = await closingStore("revokedstore");
  await told(v);
  await setStripeAccount(v.email, "acct_1SilentRevoke01");
  connected = "revoked";
  for (const d of [1, SILENT + 1, 60, 400]) {
    const r = await quietly(() => closeOne(v.email, v.ended + (C + d) * DAY, hands));
    is(`day C+${d}`, [d, r.state, r.note, filesOf(v)], [d, d <= SILENT ? "held" : "removed", r.note, d <= SILENT ? 1 : 0]);
  }
  connected = "up";

  part("The lapse's letter, and a closing out of email credit");
  const l = await closingStore("letterstore");
  await told(l);
  await setStripeAccount(l.email, "acct_1SilentLetter01");
  const ls = await storeForEmail(l.email);
  if (!ls) throw new Error("no store");
  await savePaidPeriod(ls, "sub_letter0000001", { inv: "in_letter0000001", amt: 6000, cur: "usd", ps: Math.floor((l.ended - 10 * DAY) / 1000), pe: Math.floor((l.ended + 50 * DAY) / 1000), e: "letter-member@example.com" });
  connected = "down";
  await quietly(() => closeOne(l.email, l.ended + (C + 1) * DAY, hands));
  const day = (await record(l))?.day as number;
  // Out of email credit first: the member cannot be told, so nothing is deleted.
  await redis.pipeline([["SET", creditKey(l.folder), 0]]);
  const noCredit = await quietly(() => closeOne(l.email, l.ended + (C + SILENT + 1) * DAY, hands));
  is("out of email credit: kept, nothing given up", [noCredit.state, filesOf(l), (await paidPeriods(ls)).get("sub_letter0000001")?.r], ["held", 1, undefined]);
  await redis.pipeline([["SET", creditKey(l.folder), 5]]);
  const letterBefore = sent.length;
  const lapsedLetter = await quietly(() => closeOne(l.email, l.ended + (C + SILENT + 2) * DAY, hands));
  const letter = sent.slice(letterBefore).find((x) => x.to.includes("letter-member@example.com")) as { subject: string; text?: string } | undefined;
  const dayWords = new Date(day).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  is("then it lapses, and the member is told first", [lapsedLetter.state, filesOf(l)], ["removed", 0]);
  is("the letter says the refund may not have been made, and the day the store closed, never 'today'", [/may not have been made/.test(letter?.subject ?? ""), (letter?.text ?? "").includes(dayWords), /closed today/.test(letter?.text ?? "")], [true, true, false]);
  connected = "up";

  part("Kept past the published time, counted by reason in its month, for the owner's report");
  const jan = new Date(k.ended + (C + 60) * DAY).toISOString().slice(0, 7);
  const [y, mo] = jan.split("-").map(Number);
  await heldStores.recordHeldMonth(Date.UTC(y, mo, 0, 12), true);
  const readOverdueMonth = (Reflect.get(heldStores, "readOverdueMonth") ?? (async () => "missing")) as (month: string) => Promise<unknown>;
  is("the month counts each store once, by reason", await readOverdueMonth(jan), { key: 1, answer: 0, notice: 1, other: 0 });
  const report = await companyMonthlyMarginReportWithHeld(null, Date.UTC(y, mo, 5));
  is("the owner's report reads them", [report.month, Reflect.get(report, "overdueStores")], [jan, { key: 1, answer: 0, notice: 1, other: 0 }]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
