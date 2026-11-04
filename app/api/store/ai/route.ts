import { cleanTag } from "@/lib/flow-rules";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readFileWhole } from "@/lib/file-store";
import { READ_PDF_PAGES } from "@/lib/ai-rules";
import { firstPages } from "@/lib/pdf-preview";
import { MAX_STAMP_BYTES, readableFile } from "@/lib/product-file";
import { withinLimit } from "@/lib/request-guard";
import { describePicture, fillBlock, reviewPage, rewriteBlock, writeTestHeadline, replyToReview, translatePage, writeBio, writeKitPitch, writeStoreFaq, writeStoreSetup, writeBlogPost, writeEmail, writePosts, writeOutline, writePage, writeProduct, writeQuiz, writeSequence, writeFeedback } from "@/lib/ai";
import { readTaskFor, submissionOf } from "@/lib/assignment";
import { SOCIALS, type SocialNetwork, isSocialNetwork } from "@/lib/store-socials";
import { isRewriteStyle } from "@/lib/block-rewrite-rules";
import { deliveryWords, factsFor, missedQuestions, priceWords } from "@/lib/answers";
import { parsePage } from "@/lib/sales-page";
import { coachChecks, steepestDrop } from "@/lib/page-coach";
import { readPageFacts } from "@/lib/page-facts-read";
import { readDepth, reachShares } from "@/lib/page-depth";
import { LANGUAGES, isLanguage } from "@/lib/store-language";
import { readStats } from "@/lib/stats";
import { isFree } from "@/lib/store";
import { idsOfKind, productIds, readListing, readListings } from "@/lib/catalog";
import { DEFAULT_SEQUENCE_DRAFT, MAX_SEQUENCE_PRODUCTS, SEQUENCE_DRAFT_COUNTS } from "@/lib/sequence-draft";
import { storeBase } from "@/lib/purchase-email";
import { productLink } from "@/lib/checkout-recovery";
import { readAbout } from "@/lib/product-about";
import { readReview } from "@/lib/reviews";
import { MAX_REPLY_TEXT } from "@/lib/review-summary";
import { formatMoney } from "@/lib/money";
import { AI_PER_MINUTE, EMAIL_GOALS, type EmailGoal, MAX_AI_NOTES, type ProductKind } from "@/lib/ai-rules";
import { get } from "@/lib/blob";
import { imageType, ownsImagePath } from "@/lib/product-image";
import { imageFolder } from "@/lib/store";
import { findLesson, readBody, readCourse } from "@/lib/course";
import { DEFAULT_QUIZ_DRAFT, QUIZ_DRAFT_COUNTS } from "@/lib/quiz-draft";
import { funnelType } from "@/lib/funnel-types";
import { readFunnelAsk, readFunnelFacts, writeFunnelDraft, writeFunnelResearch } from "@/lib/funnel-ai";

const KINDS: ProductKind[] = ["download", "link", "course", "membership", "call", "bundle"];

/**
 * The writing help (lib/ai.ts): `{ kind: "product" | "page" | "review" | "block" | "fill" | "alt" | "translate" | "bio" | "faq" | "kit" | "setup" | "reply" | "posts" | "blog" | "outline" | "email" | "quiz" | "feedback" | "sequence" | "funnel" | "funnel-research", … }`.
 * It writes into the studio's own boxes and saves nothing: whatever comes back
 * is the creator's to read, change and keep, or not.
 *
 * Who may ask is who may write that thing: products and courses need the
 * products permission, an email the one to write drafts (lib/team-roles.ts).
 */
export async function POST(request: NextRequest) {
  // A review or a translation sends the page being edited, which may be long, and
  // twice as long with a second version being tested (lib/sales-page.ts, MAX_PAGE_BYTES).
  const guarded = await guardStoreWrite(request, (body) => (body.kind === "email" || body.kind === "sequence" ? "draft" : body.kind === "bio" || body.kind === "faq" || body.kind === "kit" || body.kind === "setup" || body.kind === "blog" || body.kind === "funnel" || body.kind === "funnel-research" || (body.kind === "posts" && !body.product) ? "page" : body.kind === "reply" ? "reviews" : "products"), 280_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  if (!(await withinLimit("ai", store.sid || store.handle, AI_PER_MINUTE, 60))) return fail("slow", 429);
  const notes = text(body.notes, MAX_AI_NOTES + 100);

  const answer = async <T,>(result: Promise<{ ok: true; value: T; left: number } | { ok: false; reason: string }>) => {
    const done = await result;
    if (!done.ok) return fail(done.reason, done.reason === "failed" ? 502 : 400);
    return Response.json({ ok: true, value: done.value, left: done.left });
  };

  if (body.kind === "product") {
    const kind = KINDS.includes(body.productKind as ProductKind) ? (body.productKind as ProductKind) : "download";
    return answer(writeProduct(store, { title: text(body.title, 200), price: text(body.price, 40), kind, notes }));
  }
  if (body.kind === "page") {
    // The product is read here, from the store's own record, rather than taken
    // from the browser: what the page is drafted from is what the product is.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    const kind = isFree(product)
      ? "free"
      : product.course
        ? "course"
        : product.call
          ? "call"
          : product.recurring
            ? "membership"
            : product.bundle
              ? "bundle"
              : product.file
                ? "download"
                : "link";
    // The product's own PDF, its first pages only, when the creator asked for it to be read (lib/ai.ts, readPdfFacts).
    let pdf: Uint8Array | null = null;
    if (body.readFile === true) {
      const file = readableFile(product);
      if (!file) return fail("file");
      const bytes = await readFileWhole(file.pathname, MAX_STAMP_BYTES).catch(() => null);
      pdf = bytes ? await firstPages(bytes, READ_PDF_PAGES).catch(() => null) : null;
      if (!pdf) return fail("file");
    }
    return answer(
      writePage(store, {
        title: product.title,
        price: isFree(product) ? "" : formatMoney(product.priceCents, store.currency),
        kind,
        summary: product.summary,
        about,
        notes,
        pdf,
      }),
    );
  }
  if (body.kind === "review") {
    // The page as it stands in the editor, saved or not, held to the same
    // rules as a saved one; the product itself is read from the store.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const page = parsePage(body.page);
    const [about, facts, depth] = await Promise.all([
      product.about ? readAbout(store.statsId, product.id) : Promise.resolve(""),
      readPageFacts(store, product),
      readDepth(store.statsId, product.id).catch(() => ({ visitors: 0, stopped: {} })),
    ]);
    const missing = coachChecks({ page, productTitle: product.title, free: isFree(product), picture: Boolean(product.image), pictureAlt: product.image?.alt ?? "", facts })
      .filter((c) => !c.done)
      .map((c) => c.label);
    const reach = reachShares(page.blocks.map((b) => b.id), depth.stopped, depth.visitors);
    const drop = steepestDrop(page.blocks, reach);
    const stats = await readStats(store).catch(() => null);
    const views = stats?.windows.d30.viewsByProduct[product.id] ?? 0;
    const started = stats?.windows.d30.checkoutsByProduct[product.id] ?? 0;
    const asked = (await missedQuestions(store, 100).catch(() => []))
      .filter((row) => row.productId === product.id)
      .map((row) => row.question)
      .filter((q, i, all) => all.indexOf(q) === i)
      .slice(0, 8);
    if (asked.length) missing.push(`Answers to what visitors asked this page and it could not answer: ${asked.map((q) => `"${q}"`).join("; ")}`);
    const traffic = views >= 30 ? ` In the last 30 days, this page was opened ${views} times and ${started} checkouts were started.` : "";
    return answer(
      reviewPage(store, {
        facts: factsFor(store, product, about, page),
        missing,
        drop: `${drop ? `${drop.lost} of every 100 readers stop before the "${drop.kind}" section, out of ${depth.visitors} counted.` : ""}${traffic}`.trim(),
        language: LANGUAGES[store.language].english,
        free: isFree(product),
        notes,
      }),
    );
  }
  if (body.kind === "block") {
    // One block, as it stands in the editor, rewritten in the store's language
    // with the rest of the page as context; nothing is saved here.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    if (!isRewriteStyle(body.style)) return fail("invalid");
    const page = parsePage(body.page);
    const block = parsePage({ blocks: [body.block] }).blocks[0];
    if (!block) return fail("invalid");
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    return answer(
      rewriteBlock(store, { block, style: body.style, facts: factsFor(store, product, about, page), language: LANGUAGES[store.language].english }),
    );
  }
  if (body.kind === "headline") {
    // A second headline to test against the hero's (lib/ai.ts, writeTestHeadline); nothing is saved here.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const page = parsePage(body.page);
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    return answer(
      writeTestHeadline(store, { headline: text(body.headline, 200), sub: text(body.sub, 400), facts: factsFor(store, product, about, page), language: LANGUAGES[store.language].english }),
    );
  }
  if (body.kind === "fill") {
    // One empty block written from the product and the page (lib/ai.ts, fillBlock); nothing is saved here.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const page = parsePage(body.page);
    const block = parsePage({ blocks: [body.block] }).blocks[0];
    if (!block) return fail("invalid");
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    return answer(fillBlock(store, { block, facts: factsFor(store, product, about, page), language: LANGUAGES[store.language].english }));
  }
  if (body.kind === "alt") {
    // A picture of this store's own, described for someone who cannot see it (lib/ai.ts, describePicture).
    // A product's picture, or one on a page of the store's own (lib/site-page-rules.ts), named by its title.
    const sitePage = store.sitePages.find((page) => page.id === text(body.page, 12)) ?? null;
    const product = sitePage ? { title: sitePage.title } : await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const path = text(body.path, 200);
    const folder = await imageFolder(guarded.ref);
    if (!path || !ownsImagePath(path, folder)) return fail("invalid");
    const found = await get(path, { access: "private" }).catch(() => null);
    if (!found || found.statusCode !== 200 || !found.stream) return fail("invalid");
    const bytes = new Uint8Array(await new Response(found.stream).arrayBuffer());
    return answer(describePicture(store, { bytes, mediaType: imageType(path), productTitle: product.title, language: LANGUAGES[store.language].english }));
  }
  if (body.kind === "translate") {
    // The page as it stands in the editor, every word of it into one of the
    // store languages (lib/ai.ts, translatePage); nothing is saved here.
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const to = isLanguage(body.language) ? body.language : store.language;
    return answer(translatePage(store, { page: parsePage(body.page), language: LANGUAGES[to].english }));
  }
  if (body.kind === "blog") {
    // A blog post, from the creator's words and what the store sells (lib/ai.ts, writeBlogPost).
    const products = store.catalog.head.filter((p) => !p.hidden).map((p) => ({ title: p.title, summary: p.summary }));
    return answer(writeBlogPost(store, { notes, products }));
  }
  if (body.kind === "posts" && !body.product) {
    // Posts about the whole store, from its line and what it sells (the record every visit already reads).
    const listed = store.catalog.head.filter((p) => !p.hidden).slice(0, 12);
    if (listed.length === 0 && !store.bio) return fail("notes");
    const facts = [
      `Store: ${store.name}`,
      store.bio ? `About it, in the creator's words: ${store.bio}` : "",
      listed.length ? `What it sells:\n${listed.map((p) => `- ${p.title}${isFree(p) ? " (free)" : ` (${formatMoney(p.priceCents, store.currency)})`}${p.summary ? `: ${p.summary}` : ""}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return answer(writePosts(store, { facts }));
  }
  if (body.kind === "posts") {
    // Posts about one product, from its page as it stands in the editor (lib/ai.ts, writePosts).
    const product = await readListing(store, text(body.product, 40));
    if (!product) return fail("unknown", 404);
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    return answer(writePosts(store, { facts: factsFor(store, product, about, body.page ? parsePage(body.page) : null) }));
  }
  if (body.kind === "reply") {
    // The review as it is kept, never as the browser sends it (lib/reviews.ts).
    const productId = text(body.product, 40);
    const review = store.statsId ? await readReview(store.statsId, productId, text(body.id, 80)) : null;
    if (!review) return fail("unknown", 404);
    const product = await readListing(store, productId);
    return answer(
      replyToReview(store, { productTitle: product?.title ?? "", rating: review.rating, text: review.text, name: review.name, maxLength: MAX_REPLY_TEXT }),
    );
  }
  if (body.kind === "bio") {
    // What the store sells, from the record every visit already reads (lib/catalog.ts, head).
    const products = store.catalog.head.filter((p) => !p.hidden).map((p) => ({ title: p.title, summary: p.summary }));
    return answer(writeBio(store, { products, notes }));
  }
  if (body.kind === "setup") {
    return answer(writeStoreSetup(store, { about: text(body.about, MAX_AI_NOTES + 100), selling: notes }));
  }
  if (body.kind === "kit") {
    // From the record every visit already reads, and the kit as it is in the studio now (not yet saved, perhaps).
    const products = store.catalog.head.filter((p) => !p.hidden).map((p) => p.title);
    const audience = (Array.isArray(body.audience) ? body.audience.slice(0, 8) : [])
      .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : {}))
      .filter((row) => isSocialNetwork(row.n) && typeof row.count === "string" && row.count.trim())
      .map((row) => `${SOCIALS[row.n as SocialNetwork].label}: ${text(row.count, 20)}${typeof row.views === "string" && row.views.trim() ? `, ${text(row.views, 20)} average views` : ""}`);
    const facts = (Array.isArray(body.facts) ? body.facts.slice(0, 6) : []).map((fact) => text(fact, 160)).filter(Boolean);
    return answer(writeKitPitch(store, { products, audience, facts, notes }));
  }
  if (body.kind === "faq") {
    // What the store says about itself: what it sells and how each is handed
    // over, from the record every visit already reads, and the creator's notes for answers.
    const products = store.catalog.head.filter((p) => !p.hidden);
    const facts = [
      `Store: ${store.name}`,
      store.bio ? `About it: ${store.bio}` : "",
      products.length ? `What it sells:\n${products.map((p) => `- ${p.title}: ${priceWords(p, store.currency, store.tiers)} ${deliveryWords(p, store.currency)}`).join("\n")}` : "",
      `How buyers pay: on a secure payment page${store.stripeAccountId ? " run by Stripe" : ""}, into ${store.name}'s own account.`,
      store.answers.facts ? `What ${store.name} wants buyers to know:\n${store.answers.facts}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return answer(writeStoreFaq(store, { facts, notes }));
  }
  if (body.kind === "outline") {
    return answer(writeOutline(store, { title: text(body.title, 200), notes }));
  }
  if (body.kind === "quiz") {
    // The lesson is read here, from the creator's own course, never sent by the page.
    const product = await readListing(store, text(body.id, 40));
    const course = product?.course ? await readCourse(product.course.id) : null;
    const found = course ? findLesson(course, text(body.lessonId, 40)) : null;
    if (!product || !course || !found) return fail("unknown", 404);
    const asked = Number(body.count);
    const count = (QUIZ_DRAFT_COUNTS as readonly number[]).includes(asked) ? asked : DEFAULT_QUIZ_DRAFT;
    const lessonText = await readBody(course.id, found.lesson.id);
    return answer(writeQuiz(store, { course: product.title, lesson: found.lesson.title, text: lessonText, notes, count }));
  }
  if (body.kind === "feedback") {
    // What the student handed in and what was asked are read here, from the
    // creator's own course, never sent by the page.
    const product = await readListing(store, text(body.id, 40));
    const course = product?.course ? await readCourse(product.course.id) : null;
    const found = course ? findLesson(course, text(body.lessonId, 40)) : null;
    if (!product || !course || !found?.lesson.task) return fail("unknown", 404);
    const [task, work] = await Promise.all([readTaskFor(course.id, found.lesson.id), submissionOf(course.id, found.lesson.id, text(body.who, 64))]);
    if (!task || !work) return fail("unknown", 404);
    return answer(
      writeFeedback(store, { course: product.title, lesson: found.lesson.title, prompt: task.prompt, answer: work.text, file: work.file?.name ?? "", notes }),
    );
  }
  if (body.kind === "sequence") {
    // What the store sells is read here, from its own records: names, prices
    // and links the page never sends. Drafts and free things are not sold.
    const trigger = body.trigger === "product" || body.trigger === "bought" || body.trigger === "finished" || body.trigger === "tagged" ? body.trigger : "joined";
    // The label a sequence that starts with one is written for (lib/flow-rules.ts).
    const tag = trigger === "tagged" ? cleanTag(body.tag) : "";
    const hidden = new Set(idsOfKind(store, "hidden"));
    const paid = new Set(idsOfKind(store, "paid"));
    const ids = productIds(store).filter((id) => !hidden.has(id) && paid.has(id)).slice(0, MAX_SEQUENCE_PRODUCTS);
    const listings = await readListings(store, ids);
    const facts = (p: (typeof listings)[number]) => ({ title: p.title, summary: p.summary, price: priceWords(p, store.currency, store.tiers), link: productLink(store, p.id) });
    let followed: ReturnType<typeof facts> | null = null;
    if (trigger === "product" || trigger === "finished") {
      const chosen = await readListing(store, text(body.productId, 40));
      if (!chosen) return fail("unknown", 404);
      followed = facts(chosen);
    }
    const asked = Number(body.count);
    const count = (SEQUENCE_DRAFT_COUNTS as readonly number[]).includes(asked) ? asked : DEFAULT_SEQUENCE_DRAFT;
    const base = storeBase(store);
    return answer(
      writeSequence(store, {
        trigger,
        ...(tag ? { tag } : {}),
        product: followed,
        products: listings.filter((p) => !followed || p.id !== text(body.productId, 40)).map(facts),
        storeLink: base,
        ordersLink: `${base}/orders`,
        notes,
        count,
      }),
    );
  }
  if (body.kind === "funnel" || body.kind === "funnel-research") {
    // A whole funnel, or who it is for (lib/funnel-ai.ts): the products of its
    // steps are read here, from the store's own records, and checked as the
    // guided setup checks them; nothing is saved here.
    const type = funnelType(text(body.type, 40));
    if (!type) return fail("type");
    const read = await readFunnelFacts(store, type, body.products && typeof body.products === "object" && !Array.isArray(body.products) ? (body.products as Record<string, unknown>) : {});
    if (!read.ok) return Response.json({ ok: false, error: read.error, slot: read.slot }, { status: 400 });
    const ask = readFunnelAsk(body);
    if (body.kind === "funnel") return answer(writeFunnelDraft(store, read.facts, ask, body.emails === true));
    return answer(writeFunnelResearch(store, read.facts, ask));
  }
  if (body.kind === "email") {
    const goal = EMAIL_GOALS.some((g) => g.id === body.goal) ? (body.goal as EmailGoal) : "update";
    return answer(writeEmail(store, { goal, product: text(body.product, 200), link: text(body.link, 400), notes }));
  }
  return fail("invalid");
}
