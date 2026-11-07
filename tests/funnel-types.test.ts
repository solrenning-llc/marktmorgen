/**
 * Funnels to start from, by kind (lib/funnel-types.ts, added 13 October
 * 2026). What is checked:
 *
 *   - every kind is one a funnel can be: its pages at valid addresses with
 *     blocks a store's own page may have, its products and its call each
 *     named once, and within a funnel's length;
 *   - a product fills a step only if it is the kind the step asks for;
 *   - building one makes the pages it needs, empty and kept from visitors,
 *     and the funnel walking them and the chosen products in order;
 *   - it is refused without room for its pages, for the wrong product, and
 *     to a role that cannot make the store's pages.
 */
import { NextRequest } from "next/server";
import { FUNNEL_TYPES, choicesOf, freeSlug, funnelType, pagesOf, slotProblem } from "@/lib/funnel-types";
import { readForm } from "@/lib/form-store";
import { readAnswers } from "@/lib/forms";
import { MAX_FORMS } from "@/lib/forms";
import { MAX_FUNNEL_PAGES } from "@/lib/page-funnel";
import { SITE_KINDS, SLUG_PATTERN, slugProblem } from "@/lib/site-page-rules";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/page-funnels/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Every kind is a funnel that can be");
  for (const type of FUNNEL_TYPES) {
    const keys = type.slots.map((s) => s.key);
    const steps = type.slots.filter((s) => s.kind !== "target").length;
    const targets = pagesOf(type).flatMap((p) => (p.target ? [p.target] : []));
    is(`${type.id}: each slot once, within a funnel's length, every page's button leads to a slot it has`, [
      new Set(keys).size === keys.length,
      steps > 0 && steps <= MAX_FUNNEL_PAGES,
      // A page's own target is a call, or one of the funnel's products (530 [FT3]).
      targets.every((t) => type.slots.some((s) => (s.kind === "target" || s.kind === "product") && s.key === t)),
    ], [true, true, true]);
    is(`${type.id}: its pages at addresses a page may have, with blocks a store's page may hold`, pagesOf(type).every((p) => SLUG_PATTERN.test(p.slug) && slugProblem(p.slug, []) === null && p.blocks.every((k) => SITE_KINDS.includes(k)) && p.blocks[0] === "hero"), true);
  }
  is("found by its id, and nothing else", [funnelType("lead-magnet")?.label, funnelType("constructor"), funnelType("nope")], ["Lead magnet", null, null]);
  is("an address taken is numbered", [freeSlug("all-set", new Set()), freeSlug("all-set", new Set(["all-set"])), freeSlug("all-set", new Set(["all-set", "all-set-2"]))], ["all-set", "all-set-2", "all-set-3"]);

  part("A product fills a step only if it is the kind asked for");
  const step = (wants: "free" | "paid" | "any") => ({ kind: "product" as const, key: "x", label: "", wants });
  const call = { kind: "target" as const, key: "c", label: "", wants: "call" as const };
  is("free, paid, either, and a call only where a call is asked for", [
    slotProblem(step("free"), { free: true, call: false }),
    slotProblem(step("free"), { free: false, call: false }),
    slotProblem(step("paid"), { free: true, call: false }),
    slotProblem(step("any"), { free: true, call: false }),
    slotProblem(step("paid"), { free: false, call: true }),
    slotProblem(call, { free: false, call: true }),
    slotProblem(call, { free: false, call: false }),
    slotProblem(step("paid"), null),
  ], [null, "free", "paid", null, "call", null, "call", "missing"]);

  part("Building one");
  const OWNER = "kinds@example.com";
  await claimHandle(OWNER, "kindshop", "Kind Shop", "");
  await ensureStatsId(OWNER);
  const guide = await addProduct(OWNER, "Free Guide", "", "0", null);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  if (!guide.ok || !course.ok) throw new Error("no products");
  const session = await openSession(OWNER);
  const send = (body: Record<string, unknown>) =>
    POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

  const wrong = await (await send({ action: "from-type", type: "lead-magnet", name: "Guide funnel", products: { freebie: course.product.id, offer: guide.product.id } })).json();
  is("a paid product where the free one goes is refused, and nothing is made", [wrong.error, (await storeForEmail(OWNER))!.sitePages.length], ["slot_free", 0]);
  const made = await (await send({ action: "from-type", type: "lead-magnet", name: "Guide funnel", products: { freebie: guide.product.id, offer: course.product.id } })).json();
  const store = (await storeForEmail(OWNER))!;
  const funnels = await readPageFunnels(store.statsId);
  const page = store.sitePages[0];
  is("made: the free guide, the course, then a page of its own", [made.ok, funnels.length, funnels[0]?.steps.map((s) => s.kind), funnels[0]?.steps[0].id, funnels[0]?.steps[1].id, funnels[0]?.steps[2].id === page?.id, funnels[0]?.slug], [
    true,
    1,
    ["product", "product", "page"],
    guide.product.id,
    course.product.id,
    true,
    "guide-funnel",
  ]);
  is("new funnel starts disabled rather than exposing an unfinished journey", funnels[0]?.on, false);
  const blocks = await readPage(store.statsId, siteKey(page.id));
  is("the page: out of the menu, empty under its title, and kept from visitors", [page.slug, page.nav, page.from, blocks.hidden, blocks.blocks.map((b) => b.kind), blocks.blocks[0].kind === "hero" ? blocks.blocks[0].headline : ""], [
    "all-set",
    false,
    -1,
    true,
    ["hero", "steps", "cta"],
    "You're all set",
  ]);
  const again = await (await send({ action: "from-type", type: "lead-magnet", name: "Guide funnel", products: { freebie: guide.product.id, offer: course.product.id } })).json();
  is("made again: its own page and its own address", [again.ok, (await storeForEmail(OWNER))!.sitePages.map((p) => p.slug), (await readPageFunnels(store.statsId)).map((f) => f.slug).sort()], [true, ["all-set", "all-set-2"], ["guide-funnel", "guide-funnel-2"]]);

  part("Author-written page copy");
  const copyOwner = "pagecopy@example.com";
  await claimHandle(copyOwner, "pagecopyshop", "Page Copy", "");
  await ensureStatsId(copyOwner);
  const copySession = await openSession(copyOwner);
  const copySend = (pageCopy: unknown) => POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + copySession }, body: JSON.stringify({ action: "from-type", type: "application", name: "Application", products: {}, pageCopy }) }));
  for (const bad of [null, [], { unknown: { headline: "Hi", intro: "" } }, { apply: { headline: "x".repeat(121), intro: "" } }, { apply: { headline: "Hi", intro: "x".repeat(601) } }, { apply: { headline: "Hi", intro: 1 } }, { apply: { headline: "Hi", intro: "", hidden: false } }]) {
    const response = await copySend(bad);
    is("invalid page copy is refused before creating pages", [response.status, (await response.json()).error, (await storeForEmail(copyOwner))!.sitePages.length], [400, "page_copy", 0]);
  }
  const intro = "Tell us about your project.\n<script>alert(1)</script>";
  const copyMade = await (await copySend({ apply: { headline: "  Discuss your project  ", intro } })).json();
  const copyStore = (await storeForEmail(copyOwner))!;
  const copyPage = await readPage(copyStore.statsId, siteKey(copyStore.sitePages[0].id));
  is("author copy is saved as ordinary editable blocks, with form and hidden state retained", [copyMade.ok, copyPage.hidden, copyPage.blocks[0].kind === "hero" ? copyPage.blocks[0].headline : "", copyPage.blocks[1].kind === "text" ? copyPage.blocks[1].body : "", copyPage.blocks.some(block => block.kind === "form" && Boolean(block.form)), (await readPageFunnels(copyStore.statsId))[0]?.on], [true, true, "Discuss your project", intro, true, false]);

  const launchProduct = await addProduct(copyOwner, "Launch product", "", "20", null);
  if (!launchProduct.ok) throw new Error("Launch fixture unavailable");
  const launchCopy = Object.fromEntries([1, 2, 3].map(n => ["video-" + n, { headline: "Lesson " + n, intro: "Introduction " + n }]));
  const launchResponse = await POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + copySession }, body: JSON.stringify({ action: "from-type", type: "launch", name: "Launch", products: { offer: launchProduct.product.id }, pageCopy: launchCopy }) }));
  const launchMade = await launchResponse.json() as { pages: { id: string }[] };
  const launchPages = await Promise.all(launchMade.pages.map((page: { id: string }) => readPage(copyStore.statsId, siteKey(page.id))));
  is("each launch page keeps its own copy in the original journey order", launchPages.map(page => [page.blocks[0].kind === "hero" ? page.blocks[0].headline : "", page.blocks[1].kind === "text" ? page.blocks[1].body : "", page.hidden]), [["Lesson 1", "Introduction 1", true], ["Lesson 2", "Introduction 2", true], ["Lesson 3", "Introduction 3", true]]);

  part("Editable funnel form questions");
  const formOwner = "formdraft@example.com";
  await claimHandle(formOwner, "formdraftshop", "Form Draft", "");
  await ensureStatsId(formOwner);
  const formSession = await openSession(formOwner);
  const sendFormDraft = (formDrafts: unknown) => POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + formSession }, body: JSON.stringify({ action: "from-type", type: "application", name: "Application", products: {}, formDrafts }) }));
  const question = { type: "short", label: "Your project", required: true };
  const draft = { fields: [question], offerList: false };
  for (const bad of [null, [], { nope: draft }, { apply: { ...draft, fields: [] } }, { apply: { ...draft, fields: Array.from({ length: 13 }, () => question) } }, { apply: { ...draft, offerList: true } }, { apply: { ...draft, offerList: "true" } }, { apply: { ...draft, fields: [{ ...question, label: " " }] } }, { apply: { ...draft, fields: [{ ...question, label: "x".repeat(161) }] } }, { apply: { ...draft, fields: [{ ...question, type: "password" }] } }, { apply: { ...draft, fields: [{ ...question, required: "true" }] } }, { apply: { ...draft, outcomes: [] } }]) {
    const response = await sendFormDraft(bad);
    is("invalid form draft is rejected before setup writes", [response.status, (await response.json()).error, (await storeForEmail(formOwner))!.sitePages.length], [400, "form_draft", 0]);
  }
  const formMade = await (await sendFormDraft({ apply: { fields: [{ type: "email", label: "Contact email", required: true }, { type: "long", label: "  Project details  ", required: false }], offerList: false } })).json();
  const formStore = (await storeForEmail(formOwner))!;
  const formPage = await readPage(formStore.statsId, siteKey(formMade.pages[0].id));
  const formBlock = formPage.blocks.find(block => block.kind === "form");
  const savedForm = await readForm(formStore.statsId, formBlock?.kind === "form" ? formBlock.form : "");
  if (!savedForm) throw new Error("Custom form was not attached to the page");
  is("custom questions, required settings and subscription choice survive setup", [savedForm.fields.map(field => [field.type, field.label, field.required]), savedForm.offerList, formPage.hidden], [[["email", "Contact email", true], ["long", "Project details", false]], false, true]);
  is("the generated form enforces the configured required question", readAnswers(savedForm, () => []).ok, false);
  const consentMade = await (await sendFormDraft({ apply: { fields: [{ type: "email", label: "Email", required: false }], offerList: true } })).json();
  const consentPage = await readPage(formStore.statsId, siteKey(consentMade.pages[0].id));
  const consentBlock = consentPage.blocks.find(block => block.kind === "form");
  is("email subscription is offered only when explicitly selected in a draft with email", (await readForm(formStore.statsId, consentBlock?.kind === "form" ? consentBlock.form : ""))?.offerList, true);

  part("Refused");
  for (let i = 0; i < 6; i += 1) await send({ action: "from-type", type: "launch", name: `Launch ${i}`, products: { offer: course.product.id } });
  const crowded = await (await send({ action: "from-type", type: "launch", name: "One more", products: { offer: course.product.id } })).json();
  is("no room for its pages", crowded.error, "pages_full");
  is("a kind that is not one", (await (await send({ action: "from-type", type: "summit", products: {} })).json()).error, "type");
  is("a call asked for and a paid product given", (await (await send({ action: "from-type", type: "book", products: { book: "nope" } })).json()).error, "slot_missing");
  is("an application asks for no product: its page asks the questions", choicesOf(funnelType("application")!).length, 0);
  part("Capacity and partial setup failures");
  const recoveryOwner = "recovery@example.com";
  await claimHandle(recoveryOwner, "recoverystore", "Recovery", "");
  await ensureStatsId(recoveryOwner);
  const recoveryStore = (await storeForEmail(recoveryOwner))!;
  const recoverySession = await openSession(recoveryOwner);
  const recover = () => POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${recoverySession}` }, body: JSON.stringify({ action: "from-type", type: "application", name: "Recovery", products: {} }) }));
  const formKey = `nl:forms:${recoveryStore.statsId}`;
  for (let i = 0; i < MAX_FORMS; i++) await redis.pipeline([["HSET", formKey, String(i), "malformed"]]);
  const fullForms = await (await recover()).json();
  is("full form hash is refused before any page or funnel is saved", [fullForms.error, (await storeForEmail(recoveryOwner))!.sitePages.length, (await readPageFunnels(recoveryStore.statsId)).length], ["forms_full", 0, 0]);
  for (let i = 0; i < MAX_FORMS; i++) await redis.pipeline([["HDEL", formKey, String(i)]]);
  const pipeline = redis.pipeline;
  try {
    redis.pipeline = async commands => commands.some(c => c[0] === "HLEN" && c[1] === formKey) ? [null] : pipeline(commands);
    const unknownCapacity = await (await recover()).json();
    is("unknown capacity refuses setup without saving pages", [unknownCapacity.error, (await storeForEmail(recoveryOwner))!.sitePages.length], ["server_error", 0]);
  } finally { redis.pipeline = pipeline; }
  try {
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "SET" && String(c[1]).startsWith(`nl:product:page:${recoveryStore.statsId}:`))) throw new Error("Injected page write failure");
      return pipeline(commands);
    };
    const partial = await (await recover()).json();
    is("page write failure reports possible partial setup, never success", [partial.ok, partial.error, (await storeForEmail(recoveryOwner))!.sitePages.length, (await readPageFunnels(recoveryStore.statsId)).length], [false, "setup_incomplete", 1, 0]);
  } finally { redis.pipeline = pipeline; }
  try {
    redis.pipeline = async commands => commands.some(c => c[0] === "EVAL" && c[3] === formKey) ? [0] : pipeline(commands);
    const raced = await (await recover()).json();
    is("capacity changed after preflight cannot silently create a broken funnel", [raced.ok, raced.error, (await readPageFunnels(recoveryStore.statsId)).length], [false, "setup_incomplete", 0]);
  } finally { redis.pipeline = pipeline; }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
