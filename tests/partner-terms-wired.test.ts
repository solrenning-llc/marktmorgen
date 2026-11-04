/**
 * 630 [HN6](39), unit 3: the studio's route, the partner's answer route and
 * both screens. Through the real routes on a synthetic store: a share with an
 * end starts at once; a change waits and the share in force does not move; a
 * bad end is refused; the partner says no, then yes, from their own page; a
 * yes the cap no longer allows is refused; the studio and the partner's page
 * say what waits and what it means.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { affiliateCookieName, changeIdentity, partnerChangeFor, readAffiliate } from "@/lib/affiliates";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { offerWords } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { POST as answerRoute } from "@/app/api/store/affiliates/partner-answer/route";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";

// A stand-in for the email service: what an invitation says is read from here.
const mails: { to: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    mails.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }));
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_partner_terms_stand_in";
  const owner = "termswired@example.com";
  await claimHandle(owner, "termswired", "Terms Wired", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Wiredxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_wired", subscriptionId: "sub_wired", active: true, tier: "creator", period: paidPeriod() });
  const p = "aaaaaaaaaaaa";
  const q = "bbbbbbbbbbbb";
  for (const id of [p, q]) {
    const person = { id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null };
    await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person)]]);
  }
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string; state?: string };
  };
  // The partner signed in on their own page (lib/affiliates.ts affiliateForSession).
  const token = randomBytes(32).toString("hex");
  const key = `nl:aff:session:${createHash("sha256").update(`nimbus-aff-session:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", key, JSON.stringify({ s: statsId, a: p })]]);
  // What the partner's page shows (lib/affiliates.ts partnerChangeFor) and the identity its form sends with the answer.
  const shown = async () => (await partnerChangeFor((await storeForEmail(owner))!, await readAffiliate((await storeForEmail(owner))!, p))).change;
  const shownId = async () => {
    const change = await shown();
    return change ? changeIdentity(change) : "";
  };
  const answer = async (value: string, seen?: string) => {
    const form = new FormData();
    form.set("handle", "termswired");
    form.set("answer", value);
    form.set("change", seen ?? (await shownId()));
    const response = await answerRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/partner-answer", { method: "POST", headers: { cookie: `${affiliateCookieName("termswired")}=${token}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };
  const read = async (id: string) => (await readAffiliate((await storeForEmail(owner))!, id))!;
  const future = (days: number) => new Date(Date.now() + days * 86400 * 1000).toISOString().slice(0, 10);

  part("The studio's route");
  is("an end that is not after today is refused", (await post({ action: "share", id: p, percent: 30, products: [A], ends: "2020-01-01" })).error, "share_ends");
  is("a new share with an end starts at once", await post({ action: "share", id: p, percent: 30, products: [A], ends: future(60) }), { ok: true, state: "started" });
  const started = (await read(p)).share!;
  is("it runs through that day", [started.percent, typeof started.until === "number"], [30, true]);
  is("lowering it waits for the partner", await post({ action: "share", id: p, percent: 20, products: [A], ends: future(60) }), { ok: true, state: "waiting" });
  is("the share in force does not move", (await read(p)).share?.percent, 30);
  is("ending a dated share early waits too", await post({ action: "share", id: p, percent: null }), { ok: true, state: "waiting" });
  is("still in force", (await read(p)).share?.percent, 30);

  part("The partner answers on their own page");
  is("an answer that is neither yes nor no is refused", await answer("maybe"), "status 400");
  is("no keeps the share", [await answer("no"), (await read(p)).share?.percent], ["https://marktmorgen.com/@termswired/affiliates?status=partner-no#partner", 30]);
  is("nothing left to answer", await answer("yes"), "https://marktmorgen.com/@termswired/affiliates?status=partner-none#partner");
  await post({ action: "share", id: p, percent: 40, products: [A], ends: future(60) });
  is("another partner takes room on the same product", await post({ action: "share", id: q, percent: 35, products: [A] }), { ok: true, state: "started" });
  is("a yes the cap no longer allows is refused", [await answer("yes"), (await read(p)).share?.percent], ["https://marktmorgen.com/@termswired/affiliates?status=partner-cap#partner", 30]);
  await post({ action: "share", id: q, percent: null });
  is("ending a share that runs until revoked applied at once", (await read(q)).share, null);
  is("with room again, yes applies it", [await answer("yes"), (await read(p)).share?.percent], ["https://marktmorgen.com/@termswired/affiliates?status=partner-yes#partner", 40]);
  is("the history has every step", (await read(p)).terms?.history.map((s) => `${s.kind}:${s.by}`), [
    "started:creator", "asked:creator", "asked:creator", "declined:partner", "asked:creator", "changed:partner",
  ]);

  part("The answer applies to the change the partner read, never to one put in its place");
  // A new hour, so the partner's answers are not slowed by the five an hour already used above.
  advance(3601 * 1000);
  is("the store asks for 30%", await post({ action: "share", id: p, percent: 30, products: [A], ends: future(60) }), { ok: true, state: "waiting" });
  is("the partner's page shows 30%", (await shown())?.share?.percent, 30);
  const read30 = await shownId();
  is("the store switches its request to 5%", await post({ action: "share", id: p, percent: 5, products: [A], ends: future(60) }), { ok: true, state: "waiting" });
  is("the partner's yes to the 30% they read is refused", await answer("yes", read30), "https://marktmorgen.com/@termswired/affiliates?status=partner-none#partner");
  is("nothing changed: the share in force and the 5% request stay", [(await read(p)).share?.percent, (await read(p)).terms?.change?.share?.percent], [40, 5]);
  is("a yes to the 5% now shown applies 5%", [await answer("yes"), (await read(p)).share?.percent], ["https://marktmorgen.com/@termswired/affiliates?status=partner-yes#partner", 5]);
  is("the refusal says what happened and where the new request is", AFFILIATES_WORDS.en.partnerAnswered.none, "That request is no longer open. The store may have changed it or taken it back. Nothing changed, and any new request is shown on this page.");

  part("A dated share in force is not removed by the store alone");
  is("remove is refused, with the reason", (await post({ action: "remove", id: p })).error, "share_term_held");
  is("decline is refused the same way", (await post({ action: "decline", id: p })).error, "share_term_held");
  is("they stay approved with their share", [(await read(p)).status, (await read(p)).share?.percent], ["approved", 5]);
  is("a share until revoked", await post({ action: "share", id: q, percent: 10, products: [A] }), { ok: true, state: "started" });
  is("can be removed", [await post({ action: "remove", id: q }), (await read(q)).status, (await read(q)).share], [{ ok: true }, "removed", null]);
  is("and the step is in its history", (await read(q)).terms?.history.at(-1)?.kind, "revoked");

  part("An invitation says how long it runs");
  // The program switched on, which an invitation needs (lib/affiliates.ts affiliatesOn).
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 20, days: 30 }));
  is("an end that is not after today is refused", (await post({ action: "invite", email: "newpartner@example.com", percent: 10, products: [A], ends: "2020-01-01" })).error, "share_ends");
  const sentBefore = mails.length;
  const invited = await post({ action: "invite", email: "newpartner@example.com", percent: 10, products: [A], ends: future(90) });
  const mail = mails.slice(sentBefore).find((m) => m.to === "newpartner@example.com");
  is("sent, and the email states the last day", [invited.ok, /It runs through [A-Z][a-z]+ \d{1,2}, \d{4}\./.test(mail?.text ?? "")], [true, true]);
  const open = await post({ action: "invite", email: "openpartner@example.com", percent: 10, products: [A] });
  const openMail = mails.find((m) => m.to === "openpartner@example.com");
  is("without one, it says it runs until either side ends it", [open.ok, (openMail?.text ?? "").includes("It runs until you or the store end it.")], [true, true]);
  is("a creator already here reads the same in their studio", offerWords({ id: "a1b2c3d4e5f6", sid: "s", storeName: "Terms Wired", handle: "termswired", share: { percent: 10, products: [A], until: Date.UTC(2027, 2, 5) / 1000 }, titles: ["Book"], at: 0 }).endsWith("It runs through March 4, 2027."), true);

  part("The screens");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("the invitation has its own labeled end date", studio.includes('htmlFor="partner-ends"') && studio.includes('aria-describedby="partner-ends-help"') && studio.includes("ends: inviteEnds"), true);
  is("a labeled end date with its rule", studio.includes("Last day it earns (optional)") && studio.includes("aria-describedby={`${where}-ends-help`}") && studio.includes("is sent to them to accept first"), true);
  is("the studio says when a change waits and how to take it back", studio.includes("Waiting for their yes") && studio.includes("Save their current share again to take the request back."), true);
  is("and keeps the history readable", studio.includes("History of this partnership") && studio.includes("stepWords(step)"), true);
  const page = readFileSync("app/[handle]/affiliates/page.tsx", "utf8");
  is("the partner's page offers both answers in a form", page.includes('action="/api/store/affiliates/partner-answer"') && page.includes('name="answer" value="yes"') && page.includes('name="answer" value="no"'), true);
  is("and says the result in a status", page.includes('role="status"') && page.includes("a.partnerAnswered["), true);
  is("the form sends which change it showed", page.includes('name="change" value={changeIdentity(askedChange)}'), true);
  is("a refused removal says what to do instead, in the row's alert", studio.includes("their share runs to a set end date") && studio.includes("press End the partnership; it ends once they accept. Or wait until the end date, then remove them.") && studio.includes('role="alert"'), true);
  const en = AFFILIATES_WORDS.en;
  is("the words say the share stays until the answer", en.partnerAskedKeep("Dec 3, 2026"), "Until you answer, your share stays exactly as it is. If you have not answered by Dec 3, 2026, nothing changes.");
  is("an end asked for, in words", en.partnerAsked("Terms Wired", null, "", null), "Terms Wired asks to end your partner share.");
  for (const [lang, words] of Object.entries(AFFILIATES_WORDS)) {
    const line = words.partnerAsked("Shop", 20, "Book", "Mar 4, 2027");
    is(`${lang}: the change names the share, the products and the last day`, line.includes("20") && line.includes("Book") && line.includes("Mar 4, 2027"), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
