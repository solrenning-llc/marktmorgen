/**
 * 646 [WG6] unit 2: "Ask us to look again" through the real route (app/api/store/appeal), the real store record and
 * the real studio page (app/studio/appeals), against the in-memory Redis and a stubbed email provider. Synthetic
 * stores only. Each part fails on the wrong behavior it names: a request kept twice for one decision, a number given
 * twice, a request about another store's decision, an inbox never told while the page says it was, a second email for
 * one request, an unknown record taken for "no request", a store switched off that cannot ask, and a page that offers a
 * form for a decision already asked about.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { POST } from "@/app/api/store/appeal/route";
import StudioAppealsPage from "@/app/studio/appeals/page";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setSubscription, storeForEmail } from "@/lib/store";
import { NUMBER_TRIES, decisionsOf, fileAppeal, kindOfStrike, readAppeals } from "@/lib/takedown-appeals";
import { APPEAL_NUMBER } from "@/lib/takedown-appeal-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] | string; subject: string; text: string; headers?: Record<string, string> };
const sent: { body: Sent; key: string | null }[] = [];
let mailDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (mailDown) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const headers = new Headers(init?.headers);
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, key: headers.get("Idempotency-Key") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const url = "https://marktmorgen.com/api/store/appeal";
const PRODUCT = { at: "2026-11-09T12:00:00.000Z", what: 'The product "Synthetic Guide", now unpublished', report: "0123456789abcdef" };
const LINK = { at: "2026-11-09T13:00:00.000Z", what: 'The link "Synthetic file" (https://example.test/file)', report: "0123456789abcdef" };
const STORE_OFF = { at: "2026-11-09T14:00:00.000Z", what: "Your store's pages and sales, now switched off", report: "fedcba9876543210" };

async function creator(email: string, handle: string) {
  await claimHandle(email, handle, "Synthetic shop", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return { cookie: `${SESSION_COOKIE}=${await openSession(email)}` };
}

async function ask(cookie: string, _sid: string, body: Record<string, unknown>) {
  const response = await POST(new NextRequest(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function page(cookie: string, sid: string): Promise<string> {
  answering(new NextRequest(`https://marktmorgen.com/studio/appeals?store=${sid}`, { headers: { cookie } }));
  return renderToStaticMarkup(await StudioAppealsPage({ searchParams: Promise.resolve({ store: sid }) }));
}

async function main() {
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  redis.clear();
  const email = "appeal-a@example.test";
  const { cookie } = await creator(email, "appealshopa");
  let store = (await storeForEmail(email))!;

  part("A store with nothing taken down has nothing to ask about");
  is("the page says so, with no form", (await page(cookie, store.sid)).includes('data-appeals="none"'), true);

  await noteTakedown(email, PRODUCT);
  await noteTakedown(email, LINK);
  store = (await storeForEmail(email))!;
  const decisions = decisionsOf(store);
  const product = decisions.find((d) => d.kind === "product")!;
  const link = decisions.find((d) => d.kind === "link")!;

  part("Each strike is one decision, of the kind its words say");
  // The words each kind is written with, taken from lib/takedown.ts itself: a change of wording there fails here.
  const takedownSource = readFileSync("lib/takedown.ts", "utf8");
  is("lib/takedown.ts still writes each kind with the words kindOfStrike reads", ['what: `The link "', 'what: `The product "', 'what: "Your media kit', 'return { what: "Your store\'s pages and sales'].map((w) => takedownSource.includes(w)), [true, true, true, true]);
  is("kinds read from lib/takedown.ts's words", [kindOfStrike(PRODUCT.what), kindOfStrike(LINK.what), kindOfStrike("Your media kit, now unpublished"), kindOfStrike(STORE_OFF.what), kindOfStrike("Something else")], ["product", "link", "kit", "store", "other"]);
  is("two decisions, newest first", decisions.map((d) => d.kind), ["link", "product"]);
  is("no told-date is invented: the request is never refused as late", decisions.map((d) => d.informedAt), ["", ""]);
  const before = await page(cookie, store.sid);
  is("the page offers a form for each", (before.match(/Check my request/g) ?? []).length, 2);
  is("and says it is free and that the decision stays while we look", [before.includes("It is free."), before.includes("we cannot tell you in advance what we will decide")], [true, true]);
  is("the deleted link is said not to come back", before.includes("The link and its file were deleted, so they cannot be put back."), true);
  is("nothing is said about what the store can still do that this page does not offer", before.includes("You can still download"), false);

  part("A request is kept once, with a number, and our inbox is told once");
  const first = await ask(cookie, store.sid, { action: "file", decision: product.key, explanation: "I wrote this guide myself; the notice names a different book." });
  is("taken", [first.status, first.data.ok, first.data.state, first.data.told], [200, true, "received", true]);
  is("a number in its shape", APPEAL_NUMBER.test(String(first.data.number)), true);
  is("one email, to the support inbox, with the number and the words", [sent.length, sent[0]?.body.to, sent[0]?.body.subject.includes(String(first.data.number)), sent[0]?.body.text.includes("the notice names a different book")],
    [1, ["support@marktmorgen.com"], true, true]);
  is("sent under the request's first try key", sent[0]?.key, `appeal-${first.data.number}-1`);
  const again = await ask(cookie, store.sid, { action: "file", decision: product.key, explanation: "Second try." });
  is("a second request about the same decision is refused, and no email goes", [again.status, again.data.error, sent.length], [409, "already", 1]);
  const kept = await readAppeals(store);
  is("one record, Received, moved only by the creator so far", [kept.size, kept.get(product.key)?.appeal.state, kept.get(product.key)?.appeal.moves.length], [1, "received", 1]);
  const after = await page(cookie, store.sid);
  is("the page shows the request's state and number, and no form for it", [after.includes(`Request ${first.data.number}: Received.`), (after.match(/Check my request/g) ?? []).length], [true, 1]);

  part("What a request may not be");
  is("no words", (await ask(cookie, store.sid, { action: "file", decision: link.key, explanation: "   " })).data.error, "explanation");
  is("a decision this store does not have", (await ask(cookie, store.sid, { action: "file", decision: "product-x@0000000000000000", explanation: "Mine." })).data.error, "decision");
  is("an unknown action", (await ask(cookie, store.sid, { action: "delete", decision: link.key })).status, 400);
  is("no email went for any of them", sent.length, 1);

  part("Another store can neither ask about nor see this store's decisions");
  const other = await creator("appeal-b@example.test", "appealshopb");
  const otherStore = (await storeForEmail("appeal-b@example.test"))!;
  is("asking with this store's decision key", (await ask(other.cookie, otherStore.sid, { action: "file", decision: link.key, explanation: "Not mine." })).data.error, "decision");
  is("its page shows nothing taken down", (await page(other.cookie, otherStore.sid)).includes('data-appeals="none"'), true);
  // A strike alike in every word on the other store (a notice cannot do this; the test does): still two requests apart.
  await noteTakedown("appeal-b@example.test", PRODUCT);
  const twin = (await storeForEmail("appeal-b@example.test"))!;
  const twinPage = await page(other.cookie, twin.sid);
  is("an alike strike elsewhere shows a form, never this store's request", [twinPage.includes(`Request ${first.data.number}`), twinPage.includes("Check my request")], [false, true]);
  const twinAsk = await ask(other.cookie, twin.sid, { action: "file", decision: decisionsOf(twin)[0].key, explanation: "Mine, on my own store." });
  is("and that store files its own, with another number", [twinAsk.status, twinAsk.data.number !== first.data.number], [200, true]);
  const sentBefore = sent.length;

  part("An inbox email that could not go: kept, said so, and sent again once");
  mailDown = true;
  const unsent = await ask(cookie, store.sid, { action: "file", decision: link.key, explanation: "I have a license for this file." });
  is("kept, not passed on", [unsent.status, unsent.data.error], [202, "unsent"]);
  is("the page offers Send it again, never a second form", [(await page(cookie, store.sid)).includes("Send it again"), (await readAppeals(store)).get(link.key)?.told], [true, false]);
  mailDown = false;
  const resent = await ask(cookie, store.sid, { action: "again", decision: link.key });
  is("sent again: told now, one more email", [resent.status, resent.data.told, sent.length - sentBefore], [200, true, 1]);
  const twice = await ask(cookie, store.sid, { action: "again", decision: link.key });
  is("pressed again after it went: no other email", [twice.status, sent.length - sentBefore], [200, 1]);
  is("a new try has its own key", sent[sent.length - 1]?.key, `appeal-${(await readAppeals(store)).get(link.key)?.appeal.number}-2`);

  part("Tries are capped: a request whose inbox email keeps failing points to a reply instead");
  const failing = (await storeForEmail(email))!;
  await noteTakedown(email, { at: "2026-11-09T15:00:00.000Z", what: "Your media kit, now unpublished", report: "0123456789abcdef" });
  const kit = decisionsOf((await storeForEmail(email))!).find((d) => d.kind === "kit")!;
  mailDown = true;
  const t1 = await ask(cookie, failing.sid, { action: "file", decision: kit.key, explanation: "The media kit is mine." });
  const t2 = await ask(cookie, failing.sid, { action: "again", decision: kit.key });
  const t3 = await ask(cookie, failing.sid, { action: "again", decision: kit.key });
  const t4 = await ask(cookie, failing.sid, { action: "again", decision: kit.key });
  mailDown = false;
  const t5 = await ask(cookie, failing.sid, { action: "again", decision: kit.key });
  is("three tries fail, the fourth and fifth are not tried", [t1.status, t2.status, t3.status, t4.status, t5.status, sent.length - sentBefore], [202, 202, 202, 202, 202, 1]);
  is("and the words say how to reach a person", String(t5.data.message).startsWith("Your request is kept with its number, but we could not pass it on to our team. Reply to the email"), true);

  part("A store switched off can still ask");
  await noteTakedown(email, STORE_OFF, true);
  store = (await storeForEmail(email))!;
  const off = decisionsOf(store).find((d) => d.kind === "store")!;
  const offAsk = await ask(cookie, store.sid, { action: "file", decision: off.key, explanation: "The notice was about another store." });
  is("taken while switched off", [offAsk.status, offAsk.data.ok], [200, true]);

  part("An unknown record is never 'no request'");
  const kinds = (await readAppeals(store)).size;
  is("four requests kept", kinds, 4);
  const keys = [...redis.keys()].filter((k) => k.startsWith("nl:report:") && k.includes(":a:"));
  is("five records under the notices' family (four here, one on the other store)", keys.length, 5);
  await redis.pipeline(keys.map((k) => ["SET", k, "not json"]));
  is("the page reads nothing and offers nothing", (await page(cookie, store.sid)).includes('data-appeals="unknown"'), true);

  part("A decision keeps at most its few numbers, however many presses or lost replies");
  const numbers = () => [...redis.keys()].filter((k) => k.startsWith("nl:report:an:")).length;
  const raceEmail = "appeal-race@example.test";
  await creator(raceEmail, "appealshoprace");
  await noteTakedown(raceEmail, PRODUCT);
  const raceStore = (await storeForEmail(raceEmail))!;
  const raceKey = decisionsOf(raceStore)[0].key;
  const raceSent = sent.length;
  const numbersBefore = numbers();
  const presses = await Promise.all(Array.from({ length: 60 }, () => fileAppeal(raceStore, raceKey, { explanation: "Sixty presses at once." }, new Date(), "https://marktmorgen.com").catch(() => null)));
  is("sixty presses at once keep one request and send one email", [presses.filter((r) => r?.ok).length, (await readAppeals(raceStore)).size, sent.length - raceSent], [1, 1, 1]);
  is("and leave exactly one number, never one a press", numbers() - numbersBefore, 1);

  const lostEmail = "appeal-lost@example.test";
  await creator(lostEmail, "appealshoplost");
  await noteTakedown(lostEmail, LINK);
  const lostStore = (await storeForEmail(lostEmail))!;
  const lostKey = decisionsOf(lostStore)[0].key;
  const lostBefore = numbers();
  const realPipeline = redis.pipeline.bind(redis);
  // The number's write lands, then its reply is lost: every try throws closed, as an unknown reply must.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await realPipeline(commands);
    if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:report:an:")) throw new Error("reply lost");
    return replies;
  }) as typeof redis.pipeline;
  let threw = 0;
  for (let i = 0; i < 8; i++) await fileAppeal(lostStore, lostKey, { explanation: "Eight tries, every reply lost." }, new Date(), "https://marktmorgen.com").catch(() => threw++);
  redis.pipeline = realPipeline;
  is("eight tries whose replies are lost all fail closed, and leave one number, not eight", [threw, numbers() - lostBefore, (await readAppeals(lostStore)).size], [8, 1, 0]);
  const recovered = await fileAppeal(lostStore, lostKey, { explanation: "Eight tries, every reply lost." }, new Date(), "https://marktmorgen.com");
  const recoveredNumber = recovered.ok ? recovered.kept.appeal.number : "";
  is("the next try takes that same number, so nothing is left behind", [recovered.ok, numbers() - lostBefore, redis.keys().includes(`nl:report:an:${recoveredNumber}`)], [true, 1, true]);
  is(`never more than ${NUMBER_TRIES} numbers a decision`, NUMBER_TRIES, 3);

  part("The studio's notice links here for whoever may change the settings");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("one link, under the settings permission", /store\.strikes\.length && may\("settings"\)[\s\S]{0,200}studioPath\(store, "", "appeals"\)/.test(studio), true);

  done();
}

void main();
