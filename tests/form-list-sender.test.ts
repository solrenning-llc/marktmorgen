/**
 * The address a form offers the list to, asks to join and starts sequences
 * for (lib/forms.ts, readAnswers' `email`, read by app/api/store/form) is the
 * response's sender by the one rule the copy, the erasure and the deal read
 * (lib/form-respondent.ts, respondentOf). It used to be the first email
 * question that held an address, so in a form with "Invite a friend (email)"
 * before "Your email" the friend was sent the list's confirmation email, and,
 * when already on the list, started on the form's sequences, on somebody
 * else's say-so. When two email questions hold different addresses, who sent
 * the response cannot be told, and nobody is offered the list or started on
 * anything; the answers are still kept for the creator.
 *
 * Claude 5's pre-review of this branch, LIGHT 2 (VR 2): when the person checked
 * the box to hear from the creator but the sender cannot be told, nobody is
 * asked to join, and the page after the form said nothing about it. It now
 * says so, in the store's language, only then.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { parseForm, readAnswers, type FormDef } from "@/lib/forms";
import { FORM_WORDS } from "@/lib/buyer-words/form";
import { readResponses } from "@/lib/form-store";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { POST as sendForm } from "@/app/api/store/form/route";
import FormDonePage from "@/app/[handle]/form/[form]/page";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const TESS = "tess@example.com";
const OLLY = "olly@example.com";

async function main(): Promise<void> {
  const invite = parseForm({
    id: "invitefrm1",
    name: "Invite",
    fields: [
      { id: "friend", type: "email", label: "Invite a friend (email)", required: false },
      { id: "yours1", type: "email", label: "Your email", required: true },
      { id: "name01", type: "short", label: "Your name", required: false },
    ],
    offerList: true,
  })!;
  const sent = (values: Record<string, string[]>) => readAnswers(invite, (name) => values[name] ?? []);

  part("Two email questions with different addresses: nobody is offered the list");
  const both = sent({ q_friend: [TESS], q_yours1: [OLLY], q_name01: ["Olly Grant"] });
  is("no address for the list, not the friend's", both.ok ? both.email : "refused", "");
  is("the answers are still kept for the creator", both.ok ? both.answers : null, { friend: TESS, yours1: OLLY, name01: "Olly Grant" });

  part("One sender: their address");
  const own = sent({ q_yours1: [OLLY] });
  is("the friend's question left empty: the sender's own address", own.ok ? own.email : "refused", OLLY);
  const twice = sent({ q_friend: ["Olly@Example.com"], q_yours1: [OLLY] });
  is("the same address in both: that address", twice.ok ? twice.email : "refused", OLLY);

  part("The route offers the list and starts sequences only for that address");
  const route = readFileSync("app/api/store/form/route.ts", "utf8");
  is("askToJoin, leadAffiliate and enroll read read.email, nothing else typed", [
    route.includes("askToJoin({ store, email: read.email,"),
    route.includes('leadAffiliate(store, "signup", visitCookies(request, store.handle), read.email)'),
    route.includes("if (read.email) await enroll(store, read.email,"),
    /read\.answers\[/.test(route),
  ], [true, true, true, false]);

  part("The privacy policy says so");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the confirmation goes only to the sender, and to nobody when not known", privacy.includes("the email that asks them to confirm goes only to the address that sent the response, and to nobody when the sender cannot be told"), true);

  part("The box checked and the sender not known: the page after the form says nobody was added");
  is("said in every language of the store, in its own words", Object.entries(FORM_WORDS).map(([lang, w]) => [lang, typeof w.listUnknown === "string" && w.listUnknown.length > 20 && (lang === "en" || w.listUnknown !== FORM_WORDS.en.listUnknown)]), Object.keys(FORM_WORDS).map((lang) => [lang, true]));
  is("in plain English", FORM_WORDS.en.listUnknown, "We could not tell which email address is yours, so you were not added to the list.");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "listsender@example.com";
  await claimHandle(OWNER, "listsendershop", "List Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const saved = ((await (await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: { ...invite, id: undefined } }) }))).json()) as { form: FormDef }).form;
  is("the form is kept with its box", [saved.offerList, saved.fields.length], [true, 3]);
  await setSitePages(OWNER, [{ id: "pagelist01", slug: "invite", title: "Invite", nav: false, target: "", from: 0 }]);
  const shop = (await storeForEmail(OWNER))!;
  await writePage(shop.statsId!, siteKey("pagelist01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: saved.id }] } as never, ROOM);
  const [friend, yours] = saved.fields.map((f) => `q_${f.id}`);
  const post = async (pairs: [string, string][]) => (await sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7" }, body: new URLSearchParams([["handle", "listsendershop"], ["form", saved.id], ["page", "pagelist01"], ...pairs]) }))).headers.get("location") ?? "";
  const unknown = await post([[friend, TESS], [yours, OLLY], ["consent", "yes"]]);
  is("two addresses and the box checked: sent to the page that says so", [unknown.includes(`/@listsendershop/form/${saved.id}?`), new URL(unknown).searchParams.get("j")], [true, "unknown"]);
  is("the answers are kept, nobody asked to join", (await readResponses(shop.statsId, saved.id)).responses.map((r) => [r.joined, r.answers[saved.fields[0].id]]), [[false, TESS]]);
  const unchecked = await post([[friend, TESS], [yours, OLLY]]);
  is("the box not checked: nothing to say about the list", new URL(unchecked).searchParams.has("j"), false);
  is("on a step of a funnel, the page that says so comes before the next step", route.includes("if (here?.next && !outcome && !joined && !unknownSender) return go(here.next);"), true);

  const page = async (query: Record<string, string>) => renderToStaticMarkup(await FormDonePage({ params: Promise.resolve({ handle: "@listsendershop", form: saved.id }), searchParams: Promise.resolve({ p: "pagelist01", ...query }) }));
  const told = await page({ j: "unknown" });
  is("the page says nobody was added, as a status", told.includes(`role="status">${FORM_WORDS.en.listUnknown}</p>`), true);
  is("and does not say an email is on its way", told.includes(FORM_WORDS.en.confirmSent), false);
  is("without the mark, nothing about the list", [(await page({})).includes(FORM_WORDS.en.listUnknown), (await page({ j: "1" })).includes(FORM_WORDS.en.listUnknown)], [false, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
