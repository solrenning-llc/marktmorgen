/**
 * 283 [HG2], unit 1: the email on the anniversary of a purchase.
 *
 * A year after a paid one-time purchase, one email from the store, written by
 * the creator's own few words when they gave some. Stripe and the email
 * sender are played by a stand-in for `fetch`; no real email is sent. What
 * is checked:
 *
 *   - the setting: off until turned on with a postal address; the creator's
 *     words bounded; nothing else kept (no birth date, ever: only the date of
 *     the purchase already on Stripe is read);
 *   - the email: an honest subject, the purchase's real date, no urgency,
 *     scarcity, countdown or discount, in the store's language, as HTML and
 *     as text, with the one-click List-Unsubscribe headers;
 *   - who: only a buyer whose checkout said `news` "yes" AND who is on the
 *     list and may be written to (never unsubscribed, bounced, complained or
 *     deleted from the store); never a refunded or disputed purchase, a tip,
 *     a call, a membership, another store's sale or a purchase outside the
 *     window;
 *   - how often: once per person per date, however many times the job runs
 *     or how many things they bought that day;
 *   - cost: each email taken from the store's own figure before it is sent
 *     (a spent figure sends nothing and leaves no mark), at most
 *     ANNIVERSARIES_PER_STORE_RUN a store a run, counted for the studio;
 *   - unknown fails closed: a page of Stripe that is not a list, a charge not
 *     readable, a reply about deleted people that is not whole: nothing sent;
 *   - the marks go with the person (lib/person-erasure.ts);
 *   - an uncertain answer from the sender keeps the once-mark, so the
 *     daily job never writes twice (only a certain refusal lets it go);
 *   - the reading of Stripe goes on from where the last run stopped, so a
 *     store with more checkouts than one run reads still reaches its oldest.
 */
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnniversaryEditor } from "@/components/anniversary-editor";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setAnniversary, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { stopWriting, unsubscribe, upsertContact, tokensFor } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { takeAllowance } from "@/lib/store-allowance";
import { redisPipeline } from "@/lib/redis";
import {
  ANNIVERSARY_LATE_DAYS,
  MAX_ANNIVERSARY_MESSAGE,
  NO_ANNIVERSARY,
  anniversaryEmail,
  anniversaryOn,
  anniversaryWindow,
  parseAnniversary,
} from "@/lib/anniversary-rules";
import { ANNIVERSARIES_PER_STORE_RUN, anniversariesThisMonth, forgetAnniversaryPerson, sendAnniversaries } from "@/lib/anniversary-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.UTC(2026, 10, 6, 12, 0, 0);
const yearAgo = Math.floor(Date.UTC(2025, 10, 6, 9, 0, 0) / 1000);
/** The daily job `days` after the first, and a time `days` after the end of the first one's window (Stripe's seconds). */
const runOn = (days: number) => now + days * DAY * 1000;
const W0 = anniversaryWindow(now).upTo;
const afterW0 = (days: number) => Math.floor(W0 + days * DAY);

type Sent = { to: string[]; subject: string; text: string; html?: string; headers?: Record<string, string> };
const emails: Sent[] = [];
/** Every email the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
const sessions: Record<string, unknown>[] = [];
let sessionPage: (() => unknown) | null = null;
const expands: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent;
    asked.push(...body.to);
    const answer = senderAnswers.get(body.to[0] ?? "");
    if (answer) return answer();
    emails.push(body);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions") {
    expands.push(url.searchParams.getAll("expand[]").join(","));
    if (sessionPage) return answer(sessionPage());
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    // Newest first, as Stripe lists them: by time, and the later made first at the same second; pages of
    // `limit`, the next one after `starting_after`.
    const found = sessions.map((s, i) => ({ s, i })).filter(({ s }) => Number(s.created) >= gte && Number(s.created) <= lte);
    found.sort((a, b) => Number(b.s.created) - Number(a.s.created) || b.i - a.i);
    const after = url.searchParams.get("starting_after");
    const start = after ? found.findIndex(({ s }) => s.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const page = found.slice(start, start + limit);
    return answer({ object: "list", data: page.map(({ s }) => s), has_more: start + limit < found.length });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

let n = 0;
/** A checkout as Stripe lists it, with its payment and charge expanded. */
function bought(email: string, meta: Record<string, string>, extra: { created?: number; refunded?: boolean; disputed?: boolean; mode?: string; charge?: unknown; amount?: number } = {}) {
  n += 1;
  sessions.push({
    id: `cs_test_hg2${String(n).padStart(12, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: extra.mode ?? "payment",
    amount_total: extra.amount ?? 4900,
    created: extra.created ?? yearAgo,
    customer_details: { email },
    metadata: meta,
    payment_intent: {
      id: `pi_test_hg2${String(n).padStart(12, "0")}`,
      latest_charge:
        "charge" in extra ? extra.charge : { id: `ch_test_hg2${String(n).padStart(12, "0")}`, object: "charge", refunded: extra.refunded === true, amount_refunded: extra.refunded ? 4900 : 0, disputed: extra.disputed === true },
    },
  });
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_hg2_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  part("The setting");
  is("off by default", NO_ANNIVERSARY.on, false);
  is("never on without a postal address to print", parseAnniversary({ on: true, message: "Hi", address: "  " }).on, false);
  is("on with one", parseAnniversary({ on: true, message: "", address: "1 Main St, Portland, OR 97201" }).on, true);
  const long = parseAnniversary({ on: true, message: `  ${"a".repeat(MAX_ANNIVERSARY_MESSAGE + 50)}  `, address: "1 Main St" });
  is("the creator's words are cut to their bound", long.message.length, MAX_ANNIVERSARY_MESSAGE);
  is("control characters are taken out of them, line breaks kept", parseAnniversary({ on: true, message: "New\u0000 edition\r\nis out", address: "1 Main St" }).message, "New edition\nis out");
  is("nothing else is kept: no birth date, no other date", Object.keys(parseAnniversary({ on: true, message: "x", address: "1 Main St", birthday: "2000-01-01", dates: ["12-25"] })).sort(), ["address", "message", "on", "products"]);
  is("on reads the saved setting", anniversaryOn({ anniversary: parseAnniversary({ on: true, message: "", address: "1 Main St" }) }), true);

  part("The window: the same calendar day a year before, two days wide");
  const w = anniversaryWindow(now);
  is("ends a year before now", w.upTo, Math.floor(Date.UTC(2025, 10, 6, 12, 0, 0) / 1000));
  is("starts two days before that", w.from, w.upTo - 2 * DAY);
  is("a leap day's purchase comes round on March 1", new Date(anniversaryWindow(Date.UTC(2029, 2, 1, 12)).upTo * 1000).toISOString().slice(0, 10), "2028-03-01");

  part("The email says what it is");
  const sample = anniversaryEmail({ storeName: "Harbor Kitchen", title: "Bread Basics", boughtOn: "November 6, 2025", message: "A new chapter on rye is in the course.", link: "https://marktmorgen.com/@harbor" });
  is("an honest subject", sample.subject, "A year since you bought Bread Basics");
  is("it gives the real date", sample.body.includes("A year ago, on November 6, 2025, you bought Bread Basics from Harbor Kitchen."), true);
  is("it carries the creator's words as written", sample.body.includes("A new chapter on rye is in the course."), true);
  is("and the store's link", sample.body.includes("https://marktmorgen.com/@harbor"), true);
  is("no urgency, scarcity, countdown or discount of its own", /hurry|last chance|only \d|left|expires|ends|today only|%|off\b|discount|sale/i.test(`${sample.subject}\n${anniversaryEmail({ storeName: "S", title: "T", boughtOn: "d", message: "", link: "l" }).body}`), false);
  is("without words from the creator, no empty paragraph", anniversaryEmail({ storeName: "S", title: "T", boughtOn: "d", message: "", link: "l" }).body.includes("\n\n\n"), false);
  is("in the store's language", anniversaryEmail({ storeName: "S", title: "T", boughtOn: "6 de noviembre de 2025", message: "", link: "l", language: "es" }).subject, "Un año desde que compraste T");

  part("The studio says what it cannot do");
  const editor = (emailInPlan: boolean) =>
    renderToStaticMarkup(createElement(AnniversaryEditor, { setting: NO_ANNIVERSARY, storeName: "Harbor Kitchen", suggestedAddress: "", sent: 0, choices: [], connected: true, emailInPlan }));
  is("a plan without email: the page says none can go out", editor(false).includes("Your plan does not include email right now, so these emails cannot go out."), true);
  is("a plan with email: no such notice", editor(true).includes("Your plan does not include email"), false);
  is("the example gives the date as the UTC day it is", editor(true).includes("November 6, 2025 (UTC)"), true);
  is("the address field is described by its help", /id="anniversary-address"[^>]*aria-describedby="anniversary-address-help"|aria-describedby="anniversary-address-help"[^>]*id="anniversary-address"/.test(editor(true)), true);
  is("the studio says busy days can go late, and how late at most", editor(true).includes("up to a week after the date"), true);
  is("in the figures the job keeps", [editor(true).includes(`At most ${ANNIVERSARIES_PER_STORE_RUN} go out from your store each day`), ANNIVERSARY_LATE_DAYS], [true, 7]);

  part("The studio setting is saved only whole");
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  const refusedOn = await setAnniversary("owner@example.com", { on: true, message: "Hi", address: "" });
  is("on without an address is refused, said why", refusedOn.ok ? "saved" : refusedOn.reason, "address");
  const course = await addProduct("owner@example.com", "Bread Basics", "", "49");
  const guide = await addProduct("owner@example.com", "Rye Guide", "", "19");
  if (!course.ok || !guide.ok) throw new Error("no product");

  const meta = { store: "harbor", product: course.product.id, news: "yes" };
  // Two paid purchases the same day by Dana, who said yes and is on the list: one email.
  bought("dana@example.com", meta);
  bought("dana@example.com", { ...meta, product: guide.product.id });
  bought("eli@example.com", { ...meta, news: "no" }); // said no at checkout, though on the list
  bought("fay@example.com", meta); // left the list
  bought("gia@example.com", meta); // bounced
  bought("hal@example.com", meta, { refunded: true });
  bought("ivy@example.com", meta); // deleted from the store
  bought("jon@example.com", { ...meta, store: "someoneelse" });
  bought("kim@example.com", { ...meta, kind: "tip" });
  bought("lee@example.com", meta, { mode: "subscription" });
  bought("max@example.com", meta, { created: yearAgo - 10 * DAY });
  bought("ned@example.com", meta, { created: yearAgo + 30 * DAY });
  bought("ora@example.com", meta, { disputed: true });
  bought("pat@example.com", meta, { charge: "ch_not_expanded" });
  bought("quinn@example.com", { store: "harbor", product: course.product.id }); // no news box at all
  bought("rae@example.com", meta, { amount: 0 });

  let store = await storeForEmail("owner@example.com");
  if (!store?.listId) throw new Error("no list");
  const listId = store.listId;
  const agreed = (email: string) => upsertContact(listId, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
  for (const who of ["dana", "eli", "fay", "gia", "hal", "ivy", "jon", "kim", "lee", "max", "ned", "ora", "pat", "quinn", "rae"]) await agreed(`${who}@example.com`);
  const fayToken = (await tokensFor(listId, ["fay@example.com"], "harbor")).get("fay@example.com");
  if (fayToken) await unsubscribe(fayToken);
  await stopWriting(listId, "gia@example.com", "bounced");
  await redisPipeline([suppressCommand(listId, "ivy@example.com")]);

  part("Off: nothing is read, nothing sent");
  await sendAnniversaries(Date.now() + 30_000, now);
  is("a store that did not turn it on sends nothing", [emails.length, expands.length], [0, 0]);

  const saved = await setAnniversary("owner@example.com", { on: true, message: "A new chapter on rye is in the course.", address: "1 Main St, Portland, OR 97201" });
  is("saved on, with the creator's words", saved.ok ? [saved.store.anniversary.on, saved.store.anniversary.message] : saved.reason, [true, "A new chapter on rye is in the course."]);
  store = await storeForEmail("owner@example.com");

  part("Unknown fails closed");
  sessionPage = () => ({ object: "list", data: "not a list", has_more: false });
  await sendAnniversaries(Date.now() + 30_000, now);
  is("a page that is not a list: nothing sent", emails.length, 0);
  sessionPage = null;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HMGET" && String(commands[0]?.[1]).startsWith("nl:erased:")) return [["garbled"]];
    return real(commands);
  }) as typeof redis.pipeline;
  await sendAnniversaries(Date.now() + 30_000, now);
  redis.pipeline = real;
  is("deleted people not read whole: nothing sent", emails.length, 0);

  part("Who is written to");
  await sendAnniversaries(Date.now() + 30_000, now);
  is("the list's expansion of the payment and its charge is asked for", expands.at(-1), "data.payment_intent.latest_charge");
  is("exactly one email", emails.length, 1);
  is("to the buyer who said yes, is on the list, and kept what they bought", emails[0]?.to, ["dana@example.com"]);
  is("its subject names what they bought first", emails[0]?.subject, "A year since you bought Bread Basics");
  // Rule 23: the date is the UTC calendar day of the purchase, which can differ from the buyer's own, so it says so.
  is("its text gives the purchase's date, and that it is the UTC day", emails[0]?.text.includes("A year ago, on November 6, 2025 (UTC), you bought Bread Basics from Harbor Kitchen."), true);
  is("its text carries the creator's words", emails[0]?.text.includes("A new chapter on rye is in the course."), true);
  is("and their postal address", emails[0]?.text.includes("1 Main St, Portland, OR 97201"), true);
  is("an HTML part and a text part", [typeof emails[0]?.html === "string" && emails[0]!.html!.includes("<html lang="), typeof emails[0]?.text === "string"], [true, true]);
  is("one-click unsubscribe headers, as every list email", [emails[0]?.headers?.["List-Unsubscribe"]?.startsWith("<"), emails[0]?.headers?.["List-Unsubscribe-Post"]], [true, "List-Unsubscribe=One-Click"]);
  is("a working unsubscribe link in the text", /\/unsubscribe\?t=[0-9a-f]{40}/.test(emails[0]?.text ?? ""), true);
  is("counted for the studio", await anniversariesThisMonth(store!, now), 1);

  part("Once per person per date");
  await sendAnniversaries(Date.now() + 30_000, now);
  await sendAnniversaries(Date.now() + 30_000, now + DAY);
  is("never again, however many runs inside the window", emails.length, 1);

  part("Bounded per run");
  // Rule 23: the runs go forward in time, as the daily job does (they ran at the first day's moment again
  // before, which a job that goes on from where it stopped has already read past).
  const many = ANNIVERSARIES_PER_STORE_RUN + 3;
  for (let i = 0; i < many; i += 1) {
    const email = `buyer${i}@example.com`;
    bought(email, meta, { created: afterW0(1.5) });
    await agreed(email);
  }
  const start = emails.length;
  await sendAnniversaries(Date.now() + 30_000, runOn(2));
  is(`at most ${ANNIVERSARIES_PER_STORE_RUN} from one store in one run`, emails.length - start, ANNIVERSARIES_PER_STORE_RUN);
  await sendAnniversaries(Date.now() + 30_000, runOn(3));
  is("the rest the next run", emails.length - start, many);

  part("An uncertain answer from the sender keeps the mark: never twice");
  bought("una@example.com", meta, { created: afterW0(3.5) });
  await agreed("una@example.com");
  senderAnswers.set("una@example.com", () => new Response(JSON.stringify({ message: "internal" }), { status: 500 }));
  const unaMark = `nl:hg:once:${store!.statsId}:${createHash("sha256").update("nimbus-hg-once:una@example.com").digest("hex").slice(0, 32)}`;
  await sendAnniversaries(Date.now() + 30_000, runOn(4));
  redis.advance(2_000); // a mark let go lapses within a second (lib/claim-mark.ts)
  is("the sender was asked once", asked.filter((to) => to === "una@example.com").length, 1);
  is("its once-mark is kept: the email may have gone", redis.keys().includes(unaMark), true);
  senderAnswers.delete("una@example.com");
  await sendAnniversaries(Date.now() + 30_000, runOn(5));
  is("the next day's run does not ask again", asked.filter((to) => to === "una@example.com").length, 1);

  part("The reading goes on from where the last run stopped");
  // Twenty buyers who said yes, the oldest of the window, under more checkouts than one run reads (all said no).
  const early: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const email = `early${i}@example.com`;
    early.push(email);
    bought(email, meta, { created: afterW0(5.2) + i });
    await agreed(email);
  }
  for (let i = 0; i < 330; i += 1) bought(`late${i}@example.com`, { ...meta, news: "no" }, { created: afterW0(6.5) + i });
  const readStart = emails.length;
  await sendAnniversaries(Date.now() + 30_000, runOn(7));
  await sendAnniversaries(Date.now() + 30_000, runOn(8));
  is("the oldest of a busy window are reached the next run", emails.slice(readStart).flatMap((e) => e.to).sort(), [...early].sort());

  part("The marks go with the person");
  const marks = () => redis.keys().filter((k) => k.startsWith(`nl:hg:once:${store!.statsId}:`)).length;
  const had = marks();
  is("forgetting Dana takes her mark", [await forgetAnniversaryPerson(store!.statsId, "dana@example.com"), marks()], [1, had - 1]);

  part("A spent email figure sends nothing and leaves no mark");
  bought("sam@example.com", meta, { created: afterW0(8.5) });
  await agreed("sam@example.com");
  const left = await takeAllowance(store!, "email", 1, Date.now());
  if (!left.ok) throw new Error("the figure could not be read");
  // Spend the rest of the figure: the largest bite that still fits, halving until none does.
  for (let bite = left.left; bite >= 1; ) if (!(await takeAllowance(store!, "email", bite, Date.now())).ok) bite = Math.floor(bite / 2);
  const spentStart = emails.length;
  await sendAnniversaries(Date.now() + 30_000, runOn(9));
  is("nothing sent", emails.length - spentStart, 0);
  redis.advance(2_000); // a claim let go lapses within a second (lib/claim-mark.ts)
  const samMark = `nl:hg:once:${store!.statsId}:${createHash("sha256").update("nimbus-hg-once:sam@example.com").digest("hex").slice(0, 32)}`;
  is("no once-mark kept", redis.keys().includes(samMark), false);
  // The figure back (a new month): the next run reads Sam's purchase again and writes.
  await redisPipeline(redis.keys().filter((k) => k.startsWith("nl:allow:email:")).map((k) => ["DEL", k]));
  await sendAnniversaries(Date.now() + 30_000, runOn(10));
  is("so a later run sends it", emails.slice(spentStart).flatMap((e) => e.to), ["sam@example.com"]);

  part("Turned off: nothing more");
  await setAnniversary("owner@example.com", { on: false, message: "", address: "1 Main St" });
  bought("zed@example.com", meta, { created: afterW0(10.5) });
  await agreed("zed@example.com");
  const offStart = emails.length;
  await sendAnniversaries(Date.now() + 30_000, runOn(11));
  is("nothing sent once off", emails.length - offStart, 0);

  done();
}

void main();
