/**
 * A takedown never takes an unknown for "already down", and never says
 * "Done" without the notice the law asks for (Claude 6's rule-24 legal audit
 * of main, 7 November 2026, two MEDIUM findings in lib/takedown.ts).
 *
 *   1. A product whose record cannot be read is not "already down": the
 *      route answers an error the operator can try again, never 409
 *      "nothing", and the product stays published until a read says so.
 *   2. The email that tells the creator what was taken down (the prompt
 *      notice of 17 U.S.C. § 512(g)(2)(A); the statement of reasons of EU
 *      DSA Art. 17) is part of the takedown. When it cannot be sent, the
 *      operator is told so and can press again; the content stays down; a
 *      second press sends the notice under the same idempotency key, once,
 *      and writes nothing on the record twice. A press after the notice
 *      went out sends nothing.
 *   3. Content published again and taken down again under the same notice is a
 *      new takedown: its notice goes out under a new key, never answered by
 *      the provider with the first one's receipt (Claude 6, #3087, LEVE 2).
 *
 * Synthetic store, in-memory Redis, the email provider stood in by fetch.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/route";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setKit, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown, unsentNotices } from "@/lib/takedown";
import { transparencyCounts } from "@/lib/transparency";
import { KIND } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
type Sent = { to: string[] | string; subject: string; text: string; key: string };
const sent: Sent[] = [];
/** Every key a send was tried under, whether the provider took it or not. */
const tried: string[] = [];
/**
 * "refused": the provider answers 422, a confirmed refusal, so the same email may be sent again.
 * "unknown": it answers 500, which may follow acceptance, so lib/resend-fallback-transport.ts never posts that email again.
 */
let senderDown: false | "refused" | "unknown" = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    tried.push(key);
    if (senderDown) return new Response(JSON.stringify({ message: "unavailable" }), { status: senderDown === "refused" ? 422 : 500 });
    sent.push({ ...(JSON.parse(String(init?.body)) as Omit<Sent, "key">), key });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// A read that fails, or that answers nothing, for one key: what a timeout or a lost record looks like.
const realPipeline = redis.pipeline;
let fault: { key: string; mode: "throw" | "null" } | null = null;
redis.pipeline = async (commands: (string | number)[][]) => {
  const hit = fault;
  if (hit && commands.some((c) => c[0] === "GET" && c[1] === hit.key)) {
    if (hit.mode === "throw") throw new Error("Redis request timed out (test)");
    const answers = await realPipeline(commands);
    return commands.map((c, i) => (c[0] === "GET" && c[1] === hit.key ? null : answers[i]));
  }
  return realPipeline(commands);
};

const NOTICE = {
  kind: "copyright",
  url: `${ORIGIN}/@unknownshop`,
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

const settle = <T>(work: Promise<T>) => work.then((value) => ({ value }), () => "threw" as const);

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  const owner = "unknown@example.com";
  await claimHandle(owner, "unknownshop", "Unknown Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestUnknown001", true);
  await setSubscription(owner, { customerId: "cus_Unknown001", subscriptionId: "sub_Unknown001", active: true, period: paidPeriod() });
  const link = await addStoreLink(owner, "My mixtape", "https://soundcloud.com/someone/a-track");
  if (!link.ok) throw new Error("setup: link");
  // More products than the store's first page, so one of them is read from its own record, not the store's.
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const made = await addProduct(owner, `Song Pack ${i + 1}`, "", "9", null);
    if (!made.ok) throw new Error(`setup: product ${i + 1}`);
    ids.push(made.product.id);
  }
  const store = () => storeForEmail(owner).then((s) => s!);
  const onHead = new Set((await store()).catalog.head.map((l) => l.id));
  const far = ids.find((id) => !onHead.has(id));
  const near = ids.find((id) => onHead.has(id));
  if (!far || !near) throw new Error("setup: a product off the first page, and one on it");
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("setup: notice");
  if ((await fileReport(read.report, "7.7.7.7", ORIGIN)) !== "sent") throw new Error("setup: filed");
  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("setup: opened");
  const report = opened.report;
  sent.length = 0;
  tried.length = 0;

  const ask = (action: unknown) => POST(new NextRequest(`${ORIGIN}/api/takedown`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" }, body: JSON.stringify({ token, action }),
  }));
  const answer = async (action: unknown) => {
    const response = await ask(action);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, error: body.error ?? null, done: body.done ?? null };
  };
  const published = async (id: string) => ((await store()).catalog.items.find((p) => p.id === id)?.kind ?? KIND.hidden) & KIND.hidden ? "unpublished" : "published";
  const strikes = async () => (await store()).strikes.filter((s) => s.report === report.id).length;
  const steps = async () => (await transparencyCounts()).years[0]?.steps ?? {};
  const listingKey = `nl:catalog:${(await store()).catalog.id}:l:${far}`;

  part("A product whose record cannot be read is not already down");
  fault = { key: listingKey, mode: "throw" };
  const timedOut = await answer({ type: "product", id: far });
  fault = null;
  is("the read timed out: an error to try again, not 409 \"nothing\"", [timedOut.status, timedOut.error], [500, "error"]);
  is("and the product is still published, with nothing on the record and no email", [await published(far), await strikes(), sent.length], ["published", 0, 0]);
  fault = { key: listingKey, mode: "null" };
  const lost = await answer({ type: "product", id: far });
  const lostDirect = await settle(takeDown(report, await store(), { type: "product", id: far }, ORIGIN));
  fault = null;
  is("its record answered nothing although the store lists it: an error too, not \"nothing\"", [lost.status, lost.error, lostDirect], [500, "error", "threw"]);
  is("still published, nothing written, nothing sent", [await published(far), await strikes(), sent.length], ["published", 0, 0]);
  const once = await answer({ type: "product", id: far });
  is("once the read works, the same press takes it down", [once.status, once.done, await published(far)], [200, `The product "Song Pack ${ids.indexOf(far) + 1}", now unpublished`, "unpublished"]);
  is("a product the store does not list is still nothing to do", (await answer({ type: "product", id: "p_not_a_product" })).error, "nothing");

  part("The notice to the creator is part of the takedown");
  sent.length = 0;
  tried.length = 0;
  const linkId = link.store.links[0].id;
  const linkKey = `takedown-${report.id}-link-${linkId}`;
  senderDown = "refused";
  const unsent = await answer({ type: "link", id: linkId });
  senderDown = false;
  is("the email could not be sent: not \"Done\", and the operator is told the notice did not go out", [unsent.status, unsent.error, unsent.done], [500, "notice_unsent", null]);
  is("the link stays down, written on the record once", [(await store()).links.some((l) => l.id === linkId), await strikes()], [false, 2]);
  is("the button has words for that answer", readFileSync("components/takedown-actions.tsx", "utf8").includes("notice_unsent"), true);
  // Claude 6's focal review of #3087, LEVE 1: the press that failed may be the only one; the page opened again (or
  // by someone else) has no button for content that is already down, so it lists what is down without its notice.
  is("the page opened again lists the notice still owed, with what was taken down", await unsentNotices(report, await store()), [{ action: { type: "link", id: linkId }, what: 'The link "My mixtape" (https://soundcloud.com/someone/a-track)' }]);
  is("and the page offers it", readFileSync("app/takedown/[token]/page.tsx", "utf8").includes("unsentNotices("), true);
  const stepsBefore = await steps();
  const again = await answer({ type: "link", id: linkId });
  is("pressed again: the notice goes out, and it says Done", [again.status, again.done], [200, 'The link "My mixtape" (https://soundcloud.com/someone/a-track)']);
  is("one email, to the creator, about the link", [sent.length, [sent[0]?.to].flat(), sent[0]?.text.includes("My mixtape"), sent[0]?.text.includes("counter-notice")], [1, [owner], true, true]);
  const linkKeys = [...new Set([...tried, sent[0]?.key])];
  is("under the same idempotency key every try used, this takedown's own", [linkKeys.length, linkKeys[0]?.startsWith(`${linkKey}-`)], [1, true]);
  is("nothing written or counted twice", [await strikes(), JSON.stringify(await steps()) === JSON.stringify(stepsBefore)], [2, true]);
  is("once it went out, nothing is owed any more", await unsentNotices(report, await store()), []);
  const third = await answer({ type: "link", id: linkId });
  is("pressed a third time, after the notice went out: nothing to do, nothing sent", [third.status, third.error, sent.length], [409, "nothing", 1]);

  part("A takedown whose notice went out the first time");
  sent.length = 0;
  const first = await answer({ type: "product", id: near });
  is("taken down and told, at once", [first.status, await published(near), sent.length], [200, "unpublished", 1]);
  const repeat = await answer({ type: "product", id: near });
  is("a second press: already down, nothing sent again", [repeat.status, repeat.error, sent.length], [409, "nothing", 1]);

  part("A store switched off, its notice unsent");
  sent.length = 0;
  tried.length = 0;
  senderDown = "refused";
  const off = await answer({ type: "store", on: true });
  senderDown = false;
  is("not Done, and the store stays off", [off.status, off.error, Boolean((await store()).suspended)], [500, "notice_unsent", true]);
  const offAgain = await answer({ type: "store", on: true });
  const offKeys = [...new Set(tried)];
  is("pressed again: the notice goes out once, under the same key", [offAgain.status, sent.length, offKeys.length, offKeys[0]?.startsWith(`takedown-${report.id}-store--`)], [200, 1, 1, true]);
  const offThird = await answer({ type: "store", on: true });
  is("and then nothing more", [offThird.status, sent.length], [409, 1]);

  part("A notice the provider may have taken is never called sent, nor sent twice");
  await setKit(owner, { ...(await store()).kit, on: true });
  if (!(await store()).kit.on) throw new Error("setup: the media kit did not switch on");
  sent.length = 0;
  tried.length = 0;
  senderDown = "unknown";
  const maybe = await answer({ type: "kit" });
  senderDown = false;
  // Rule 23 (uncertain sends, 9 Nov 2026): the error was "notice_unsent" ("press again"); a 500 may follow acceptance,
  // so it is now "notice_unsure", which no press sends again. Not Done, the kit down and one post stay as they were.
  is("the provider answered 500: not Done, the kit stays down", [maybe.status, maybe.error, (await store()).kit.on], [500, "notice_unsure", false]);
  const maybeAgain = await answer({ type: "kit" });
  is("pressed again: still not Done and not \"already down\", and the email is not posted a second time", [maybeAgain.status, maybeAgain.error, tried.length, sent.length], [500, "notice_unsure", 1, 0]);

  part("Published again and taken down again under the same notice: a new notice, under a new key");
  // Claude 6's focal review of #3087, LEVE 2: the second takedown reused the first one's idempotency key,
  // so the provider answered with the first receipt and the creator was never told the second time.
  if (!(await setProductHidden(owner, near, false)).ok || (await published(near)) !== "published") throw new Error("setup: the product did not publish again");
  sent.length = 0;
  tried.length = 0;
  const firstKey = `takedown-${report.id}-product-${near}`;
  const twice = await answer({ type: "product", id: near });
  is("taken down again, and Done", [twice.status, await published(near)], [200, "unpublished"]);
  is("one new email, under a key that is not the first takedown's", [sent.length, sent[0]?.key !== firstKey, sent[0]?.key.startsWith(`${firstKey}-`)], [1, true, true]);
  const twiceAgain = await answer({ type: "product", id: near });
  is("and a press after it: nothing more", [twiceAgain.status, twiceAgain.error, sent.length], [409, "nothing", 1]);

  part("Two presses at once take the content down once, write it once and tell the creator once");
  // Claude 6's focal review of #3087, LEVE 3: two presses at once both saw the product up, both wrote fresh steps
  // and both went on (or the one that changed nothing deleted the other's steps record blindly).
  const raced = ids.find((id) => id !== near && id !== far)!;
  sent.length = 0;
  tried.length = 0;
  const strikesBeforeRace = await strikes();
  const both = await Promise.all([answer({ type: "product", id: raced }), answer({ type: "product", id: raced })]);
  is("one press takes it down, the other finds nothing left to do", both.map((r) => `${r.status} ${r.error}`).sort(), ["200 null", "409 nothing"]);
  is("down, written on the record once, one email", [await published(raced), (await strikes()) - strikesBeforeRace, sent.length], ["unpublished", 1, 1]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
