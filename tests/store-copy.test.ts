/**
 * Copying a whole store into another store of the same account
 * (app/api/store/store-copy, lib/store-copy.ts, lib/store-copy-rules.ts;
 * added 18 October 2026), end to end through the route against the
 * in-memory Redis:
 *
 *   - only the account's owner, only between its own stores;
 *   - the preview writes nothing and says what is made, what is left out
 *     and what does not fit; a copy that does not fit as a whole (another
 *     currency, a data room too full, the month's studio requests) is
 *     refused before anything is written;
 *   - the copy makes drafts of the products (words, prices, checkout boxes
 *     mapped, long descriptions, pages of blocks without pictures), the
 *     forms without an answer, the pages kept back, the funnels off, and the
 *     setup when asked, with every product they name mapped to its copy;
 *   - nothing personal and nothing of the first store's comes across: no
 *     customer, contact, answer, review, order, file, picture, Stripe
 *     account or store id;
 *   - done twice, or after its progress is lost, it makes nothing twice;
 *   - each step is charged to the other store's studio requests before it
 *     writes, and its store commands, measured, stay inside what it is
 *     charged for.
 */
import { NextRequest } from "next/server";
import { addProduct, addStoreLink, claimHandle, createStore, ensureStatsId, setAnnouncement, setCurrency, setFaq, setLinkImage, setProductAbout, setProductExtras, setProductFile, setProductImage, setProductLink, setProductPage, setSections, setSocials, setStripeAccount, setSubscription, appendSitePages, storeForEmail, storeForId, storeRef, type Store } from "@/lib/store";
import { readProducts } from "@/lib/catalog";
import { putMember } from "@/lib/team";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAbout, writeAbout } from "@/lib/product-about";
import { readPage, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { parseForm } from "@/lib/forms";
import { addResponse, readForms, readResponses, writeForm } from "@/lib/form-store";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { upsertContact } from "@/lib/contacts";
import { saveReview } from "@/lib/reviews";
import { noteData } from "@/lib/store-data";
import { allowanceUsed } from "@/lib/store-allowance";
import { COPY_UNIT_BYTES, COPY_UNIT_COMMANDS, skipReason } from "@/lib/store-copy-rules";
import { TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { idFor } from "@/lib/store-copy";
import { POST } from "@/app/api/store/store-copy/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

// Every command the code sends to the store, counted.
let commands = 0;
const pipeline = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof pipeline }).pipeline = (cmds) => {
  commands += cmds.length;
  return pipeline(cmds);
};

const OWNER = "owner@example.com";
const MATE = "mate@example.com";
const OTHER = "other@example.com";
const BUYER = "buyer.private@example.com";
const paid = { active: true, tier: "creator" as const, cycle: "month" as const, subscriptionId: null, customerId: null, trialEnds: 0 };
const pic = (n: number) => ({ path: `images/${"a".repeat(24)}/${String(n).padStart(32, "c")}.jpg`, width: 1200, height: 900, alt: "", caption: "" });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "firstshop", "First Shop", "Recipes for busy weeks.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_fixture012", true);
  await setSubscription(OWNER, paid);
  const second = await createStore(OWNER, "secondshop", "Second Shop", "");
  if (!second.ok) throw new Error("no second store");
  const secondRef = storeRef(second.store);
  await ensureStatsId(secondRef);
  await setSubscription(secondRef, paid);
  await claimHandle(OTHER, "othershop", "Other Shop", "");
  await ensureStatsId(OTHER);

  // The first store: products of every kind a copy meets.
  const guide = await addProduct(OWNER, "Dinner Guide", "Thirty dinners.", "19", null);
  const free = await addProduct(OWNER, "Pantry List", "One page.", "0", null);
  const bake = await addProduct(OWNER, "Sunday Baking", "Twelve loaves.", "24", null);
  if (!guide.ok || !free.ok || !bake.ok) throw new Error("no products");
  // More than one step's worth, so the products come across in two steps.
  for (let n = 1; n <= 27; n += 1) if (!(await addProduct(OWNER, `Extra ${n}`, `Recipe number ${n}.`, "5", null)).ok) throw new Error("no extra product");
  await setProductFile(OWNER, guide.product.id, { pathname: "files/aaaaaaaaaaaaaaaaaaaaaaaa/guide.pdf", name: "guide.pdf", bytes: 1000, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00Z" });
  await setProductImage(OWNER, guide.product.id, { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`, width: 1200, height: 800, alt: "", bytes: 1, small: null });
  await setProductLink(OWNER, bake.product.id, "https://example.com/bake");
  const bumped = await setProductExtras(OWNER, guide.product.id, { bump: { productId: bake.product.id, priceCents: 900, pitch: "For the weekend." }, slot: 0 });
  if (!bumped.ok) throw new Error(`the box was refused: ${bumped.reason}`);
  let first = (await storeForEmail(OWNER))!;
  await writeAbout(first.statsId!, guide.product.id, "Every recipe takes half an hour.", first);
  await setProductAbout(OWNER, guide.product.id, true);
  await writePage(first.statsId!, guide.product.id, parsePage({ blocks: [
    { id: "hero0001", kind: "hero", headline: "Dinner in thirty minutes", sub: "", media: "none", video: null },
    { id: "pics0001", kind: "pictures", heading: "Inside", items: [pic(1), pic(2)] },
    { id: "prod0001", kind: "product", heading: "Add baking", product: bake.product.id, note: "" },
  ] }), first);
  await setProductPage(OWNER, guide.product.id, true);
  // A quiz whose result suggests a product, and an answer to it, which is a person's.
  const quiz = parseForm({ id: "quizquiz01", name: "Which book", fields: [{ id: "aaaaaa", type: "email", label: "Your email", required: true }, { id: "bbbbbb", type: "choice", label: "Time?", required: true, options: [{ id: "opt001", label: "An hour", outcome: "res001" }] }], outcomes: [{ id: "res001", title: "Quick meals", body: "", product: guide.product.id }], offerList: true })!;
  await writeForm(first.statsId!, quiz);
  await addResponse(first.statsId!, quiz.id, { at: Date.now(), page: "", answers: { aaaaaa: BUYER, bbbbbb: "opt001" }, outcome: "res001", joined: true }, first);
  // A page of the store's own with a form on it, and a funnel through it.
  await appendSitePages(OWNER, [{ id: "pagepage01", slug: "start", title: "Start here", nav: true, target: free.product.id, from: 0 }]);
  first = (await storeForEmail(OWNER))!;
  await writePage(first.statsId!, siteKey("pagepage01"), parsePage({ blocks: [{ id: "form0001", kind: "form", heading: "Find your book", form: quiz.id }] }), first);
  await writePageFunnel(first.statsId!, { id: "funnel0001", name: "Start funnel", slug: "start-funnel", steps: [{ kind: "page", id: "pagepage01" }, { kind: "product", id: guide.product.id }], on: true, since: 1 }, [], first);
  // The store page's setup.
  await setSections(OWNER, [{ title: "Books", at: guide.product.id }]);
  await setAnnouncement(OWNER, { text: "New: Sunday Baking", product: bake.product.id });
  const link = await addStoreLink(OWNER, "My podcast", "https://example.com/podcast");
  if (!link.ok) throw new Error("no link");
  await setLinkImage(OWNER, link.store.links[0].id, { path: `images/${"a".repeat(24)}/${"e".repeat(32)}.webp`, width: 320, height: 320, bytes: 1 });
  await setSocials(OWNER, [{ network: "instagram", url: "https://instagram.com/firstshop" }, { network: "email", url: "mailto:owner@example.com" }]);
  await setFaq(OWNER, [{ q: "Do I get updates?", a: "Yes, free." }]);
  // What is a person's: a contact, a review.
  first = (await storeForEmail(OWNER))!;
  await upsertContact(first.listId ?? "list-first", BUYER, { agreed: true, explicit: true, source: "free" }, ROOM);
  await saveReview(first.statsId!, { productId: guide.product.id, email: BUYER, reference: "cs_test_copy1", pi: "pi_copy1", rating: 5, text: "Private words about dinners.", name: "Private Buyer" }, first);

  await putMember(first, MATE, "admin");
  const sessions: Record<string, string> = { [OWNER]: await openSession(OWNER), [MATE]: await openSession(MATE), [OTHER]: await openSession(OTHER) };
  const send = async (who: string, body: Record<string, unknown>, sid = first.sid) =>
    (await POST(new NextRequest("https://marktmorgen.com/api/store/store-copy", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": sid, cookie: `${SESSION_COOKIE}=${sessions[who]}` }, body: JSON.stringify(body) }))).json();
  const to = second.store.sid;
  const target = async (): Promise<Store> => (await storeForId(to))!;

  part("Only the account's owner, only into its own stores");
  is("a teammate is refused", (await send(MATE, { action: "preview", to })).error, "owner_only");
  const other = (await storeForEmail(OTHER))!;
  is("a store of anyone else is not a destination", (await send(OWNER, { action: "preview", to: other.sid })).error, "not_yours");
  is("nor the store it is in", (await send(OWNER, { action: "preview", to: first.sid })).error, "not_yours");

  part("What is copied, and what is not, is decided by the rules");
  const base = (await readProducts(first, [guide.product.id]))[0];
  is("a call, a course, a podcast, options or keys are not copied", [
    skipReason({ ...base, call: { kind: "once" } as never }),
    skipReason({ ...base, course: { id: "c".repeat(24), lessons: 1 } }),
    skipReason({ ...base, podcast: { id: "p", episodes: 1 } as never }),
    skipReason({ ...base, options: [{ id: "o1" } as never] }),
    skipReason({ ...base, keys: { source: "pool" } as never }),
    skipReason({ ...base, bundle: ["missing"] }, new Set([guide.product.id])),
    skipReason(base),
  ], ["call", "course", "podcast", "options", "keys", "bundle", null]);

  part("The preview writes nothing");
  const before = (await target()).catalog.items.length;
  const preview = await send(OWNER, { action: "preview", to, setup: true });
  is("it fits, names the other store, and counts what it makes", [preview.ok, preview.fits, preview.to.name, preview.needs.products, preview.needs.pages, preview.needs.forms, preview.needs.funnels], [true, true, "Second Shop", 30, 1, 1, 1]);
  const words = preview.lines.map((l: { text: string }) => l.text).join(" ");
  is("it says the file and the pictures stay, and what is never copied", [words.includes("without the file it delivers"), words.includes("Pictures are never copied"), words.includes("Never copied: customers, orders")], [true, true, true]);
  is("and makes nothing there", (await target()).catalog.items.length, before);

  part("A copy that does not fit as a whole is refused before anything is written");
  await setCurrency(secondRef, "eur");
  const euro = await send(OWNER, { action: "step", to, copy: "1".repeat(32) });
  is("another currency", [euro.error, euro.lines.some((l: { level: string; text: string }) => l.level === "stop" && l.text.includes("same currency"))], ["plan", true]);
  await setCurrency(secondRef, "usd");
  const room = await target();
  await noteData(room, [{ slot: "filler", bytes: 1e12, set: true }]);
  const full = await send(OWNER, { action: "step", to, copy: "2".repeat(32) });
  is("a data room too full", [full.error, full.lines.some((l: { text: string }) => l.text.includes("data room"))], ["plan", true]);
  await noteData(room, [{ slot: "filler", bytes: 0, set: true }]);
  // The other store's studio requests cannot be read: refused as a plan that cannot be checked, never taken for room.
  const original = redis.pipeline;
  redis.pipeline = async (commands) =>
    commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:allow:studio:") ? ["many"] : original(commands);
  let unread: { error?: string; lines?: { level: string; text: string }[] };
  try {
    unread = await send(OWNER, { action: "step", to, copy: "3".repeat(32) });
  } finally {
    redis.pipeline = original;
  }
  is("the other store's studio requests unread", [unread.error, unread.lines?.some((l) => l.level === "stop" && l.text.includes("can't be read just now"))], ["plan", true]);
  is("nothing was written there", [(await target()).catalog.items.length, (await target()).sitePages.length], [before, 0]);

  part("The copy, step by step");
  const copy = "c0ffee".padEnd(32, "0");
  const steps: { commands: number; units: number }[] = [];
  let answer: Record<string, unknown> = {};
  for (let n = 0; n < 12 && !answer.done; n += 1) {
    const used = await allowanceUsed(await target(), "studio");
    const at = commands;
    answer = await send(OWNER, { action: "step", to, copy, setup: true });
    if (!answer.ok) throw new Error(`a step failed: ${JSON.stringify(answer)}`);
    steps.push({ commands: commands - at, units: (await allowanceUsed(await target(), "studio")) - used });
  }
  is("it ends, having made each part", [answer.done, answer.made], [true, { products: 30, forms: 1, pages: 1, funnels: 1, setup: true }]);
  const second2 = await target();
  const made = await readProducts(second2);
  const id = (src: string) => idFor(copy, "p", src);
  const guideCopy = made.find((p) => p.id === id(guide.product.id))!;
  is("every product a draft, with the first store's words and prices", made.filter((p) => !p.title.startsWith("Extra")).map((p) => [p.title, p.priceCents, p.hidden]).sort(), [["Dinner Guide", 1900, true], ["Pantry List", 0, true], ["Sunday Baking", 2400, true]]);
  is("all thirty, every one a draft", [made.length, made.every((p) => p.hidden)], [30, true]);
  is("the box at checkout offers the copy of the product it offered", guideCopy.bumps.map((b) => b.productId), [id(bake.product.id)]);
  is("without the file it delivers or its picture", [guideCopy.file, guideCopy.image], [null, null]);
  is("its long description comes across", await readAbout(second2.statsId, guideCopy.id), "Every recipe takes half an hour.");
  const guidePage = await readPage(second2.statsId, guideCopy.id);
  const pictures = guidePage.blocks.find((b) => b.kind === "pictures") as { items: unknown[] } | undefined;
  const productBlock = guidePage.blocks.find((b) => b.kind === "product") as { product: string } | undefined;
  is("its page: the words, no pictures, the product named mapped, kept back", [guidePage.blocks[0].kind, pictures?.items.length, productBlock?.product, guidePage.hidden], ["hero", 0, id(bake.product.id), true]);
  const forms = await readForms(second2.statsId);
  is("the quiz, its result pointing at the copy, and none of its answers", [forms.length, forms[0]?.outcomes[0].product, (await readResponses(second2.statsId, forms[0]?.id ?? "")).total], [1, id(guide.product.id), 0]);
  const page = second2.sitePages[0];
  const pageBlocks = await readPage(second2.statsId, siteKey(page.id));
  is("the store's own page: out of the menu, kept back, its form mapped", [page.nav, page.from, page.target, (pageBlocks.blocks[0] as { form: string }).form], [false, -1, id(free.product.id), forms[0]?.id]);
  const funnels = await readPageFunnels(second2.statsId);
  is("the funnel: off, through the copies", [funnels[0]?.on, funnels[0]?.steps], [false, [{ kind: "page", id: page.id }, { kind: "product", id: id(guide.product.id) }]]);
  is("the setup: about line, sections and news mapped, the link without its picture, no email profile", [second2.bio, second2.sections, second2.announcement, second2.links.map((l) => [l.title, Boolean(l.image)]), second2.socials.map((s) => s.network), second2.faq.length], [
    "Recipes for busy weeks.",
    [{ title: "Books", at: id(guide.product.id) }],
    { text: "New: Sunday Baking", product: id(bake.product.id) },
    [["My podcast", false]],
    ["instagram"],
    1,
  ]);

  part("Nothing personal and nothing of the first store's comes across");
  const keys = redis.keys().filter((k) => k.includes(second2.statsId!) || k.includes(second2.sid) || (second2.listId ? k.includes(second2.listId) : false));
  const written = JSON.stringify([second2, made, guidePage, pageBlocks, forms, funnels]);
  is("no buyer, review, Stripe account or first store id", [BUYER, "Private words", "acct_fixture012", first.sid, first.statsId!, guide.product.id, "files/aaaa"].filter((needle) => written.includes(needle)), []);
  // A key the stand-in keeps after a read of an empty list holds nothing: only keys with something in them count.
  const held: string[] = [];
  for (const k of keys.filter((k) => /review|contact|:form:r:|order/.test(k))) {
    const [type] = await redis.pipeline([["TYPE", k]]);
    const [size] = await redis.pipeline([[type === "list" ? "LLEN" : type === "hash" ? "HLEN" : type === "zset" ? "ZCARD" : type === "set" ? "SCARD" : "STRLEN", k]]);
    if (Number(size) > 0) held.push(k);
  }
  is("no contact, review or answer kept in the other store", held, []);
  is("the other store's own payment account is untouched", second2.stripeAccountId, null);

  part("Done twice, or after its progress is lost, it makes nothing twice");
  const again = await send(OWNER, { action: "step", to, copy, setup: true });
  is("the same copy again says it is done", [again.ok, again.done], [true, true]);
  await redis.pipeline([["DEL", `nl:copy:${to}:${copy}`]]);
  let redo: Record<string, unknown> = {};
  for (let n = 0; n < 12 && !redo.done; n += 1) redo = await send(OWNER, { action: "step", to, copy, setup: true });
  const after = await target();
  is("run from the start again, it finds everything already there", [redo.done, (redo.made as { products: number }).products, after.catalog.items.length, after.sitePages.length, (await readForms(after.statsId)).length, (await readPageFunnels(after.statsId)).length], [true, 0, 30, 1, 1, 1]);

  part("Charged before it writes, and its store commands measured");
  is("what one studio request of a copy stands for costs no more than a studio request is priced at", request("studio", COPY_UNIT_COMMANDS + TAKE_COMMANDS, COPY_UNIT_BYTES) <= UNIT_COST.studio, true);
  is("every step took studio requests of the other store", steps.every((s) => s.units >= 2), true);
  is("each step's commands are inside what it was charged for", steps.filter((s) => s.commands > s.units * COPY_UNIT_COMMANDS).map((s) => s.commands), []);
  is("a whole copy of this store, thirty products, stays under a hundred studio requests", steps.reduce((sum, s) => sum + s.units, 0) < 100, true);
  console.log("store commands per step, measured:", steps.map((s) => `${s.commands}/${s.units}u`).join(", "));
  // With the month's studio requests used, a step is refused before it writes.
  const third = await createStore(OWNER, "thirdshop", "Third Shop", "");
  if (!third.ok) throw new Error("no third store");
  await ensureStatsId(storeRef(third.store));
  await setSubscription(storeRef(third.store), paid);
  const thirdStore = (await storeForId(third.store.sid))!;
  const { takeAllowance } = await import("@/lib/store-allowance");
  await takeAllowance(thirdStore, "studio", 1_990);
  const used = await send(OWNER, { action: "step", to: third.store.sid, copy: "d".repeat(32) });
  is("refused, and nothing made", [used.ok, (await storeForId(third.store.sid))!.catalog.items.length], [false, 0]);
  // The same copy's id, sent from another store into the one it went to, is refused rather than mixed with it.
  const elsewhere = await send(OWNER, { action: "step", to, copy }, third.store.sid);
  is("a copy's id from another store is not taken for this one", elsewhere.error, "other_copy");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
