/**
 * A booking block (lib/sales-page.ts, BookingBlock; queue item 552 [BB1],
 * unit 1): kept, checked and drawn, not offered in the studio yet.
 *
 * What is checked, against the real parser, the real cards and the real
 * drawing:
 *
 *   - a block with a call's id and a heading within MAX_HEADING is kept
 *     exactly as sent; without a call, with a heading that would be cut
 *     short, or as a second one on the page, it is not kept and is told back
 *     as "booking";
 *   - its words are only its heading: the Terms check (567 [GD1]) reads it,
 *     a translation puts it back, the call's id is never a word;
 *   - a copy into another store maps the call, or leaves the block out and
 *     counts it;
 *   - the card is read from the listings the store record already holds:
 *     a call's name, length and place, with the booking page's own words in
 *     every language, and nothing for a call that is gone, a draft, not a
 *     call or not on sale; never a count of seats;
 *   - on the page, a link whose name says where it leads on its own (WCAG
 *     2.4.9), at least 44 pixels high, to the call's own booking page; no
 *     link where there is no date on sale, and nothing at all for a call
 *     that has no card;
 *   - "booking" is not in the block gallery, nor on a store's own pages, until
 *     its picker and editor exist (VR).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView } from "@/components/sales-blocks";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { SITE_KINDS } from "@/lib/site-page-rules";
import { fastMoneyOnPage } from "@/lib/terms-check-rules";
import { keepEveryBlock, pageWords, withWords } from "@/lib/page-translate";
import { copiedBlocks, emptyBlocksLeft } from "@/lib/store-copy-rules";
import { bookingCardOf, bookingCards } from "@/lib/booking-cards";
import { bookingWords } from "@/lib/buyer-words/booking";
import { wordsIn } from "@/lib/buyer-words";
import type { CallSetup } from "@/lib/call-setup";
import type { Listing, Store } from "@/lib/store";
import { BLOCK_KINDS, MAX_BOOKING_BLOCKS, MAX_HEADING, type PageBlock, emptyBlock, pageProblem, parsePage } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const keep = (blocks: unknown[], variant?: unknown) => {
  const raw = { blocks, ...(variant ? { variant } : {}) };
  const page = parsePage(raw);
  return { page, problem: pageProblem(raw, page) };
};
const booking = (extra: Record<string, unknown> = {}) => ({ id: "book0001", kind: "booking", product: "call000001", heading: "Talk it through first", ...extra });

part("Kept whole, or refused and told back");
{
  const kept = keep([booking()]);
  is("a call's id and a heading: kept exactly as sent", [kept.page.blocks, kept.problem], [[{ id: "book0001", kind: "booking", product: "call000001", heading: "Talk it through first" }], null]);
  const bare = keep([{ id: "book0001", kind: "booking", product: "call000001" }]);
  is("the heading is optional", [bare.page.blocks, bare.problem], [[{ id: "book0001", kind: "booking", product: "call000001", heading: "" }], null]);
  const edge = keep([booking({ heading: "x".repeat(MAX_HEADING) })]);
  is("a heading of exactly the limit is kept whole", [edge.page.blocks.length, edge.problem], [1, null]);
  const extra = keep([booking({ html: "<script>alert(1)</script>", times: [1, 2], price: 0 })]);
  is("nothing else sent is kept with it", extra.page.blocks, [{ id: "book0001", kind: "booking", product: "call000001", heading: "Talk it through first" }]);
  is("it may show only on phones, like any block", keep([booking({ screens: "phone" })]).page.blocks[0]?.screens, "phone");
  const refused: [string, unknown][] = [
    ["no call chosen", booking({ product: "" })],
    ["no call at all", { id: "book0001", kind: "booking", heading: "Book" }],
    ["a call's id that is not an id", booking({ product: "CALL 1/../x" })],
    ["a call's id that is not a word", booking({ product: 12345678 })],
    ["a heading that would be cut short", booking({ heading: "x".repeat(MAX_HEADING + 1) })],
    ["a heading that is not words", booking({ heading: { text: "Book" } })],
  ];
  for (const [what, sent] of refused) {
    const out = keep([sent]);
    is(`${what}: not kept, and told back`, [out.page.blocks.length, out.problem], [0, "booking"]);
  }
  is("one booking block a page", MAX_BOOKING_BLOCKS, 1);
  const two = keep([booking(), booking({ id: "book0002", product: "call000002" })]);
  is("a second one is not kept, and told back", [two.page.blocks.map((b) => b.id), two.problem], [["book0001"], "booking"]);
  const versions = keep([booking()], { blocks: [booking({ id: "book0002", heading: "Pick your time" })] });
  is("a second version of the page has its own one", [versions.page.variant?.blocks.map((b) => b.kind), versions.problem], [["booking"], null]);
  const twoInB = keep([booking()], { blocks: [booking({ id: "book0002", heading: "Pick your time" }), booking({ id: "book0003", heading: "Again" })] });
  is("and no more than one either", twoInB.problem, "booking");
  is("an empty one has no call and no heading", emptyBlock("booking", "book0009"), { id: "book0009", kind: "booking", product: "", heading: "" });
}

part("Its words are its heading, and only its heading");
{
  const page = keep([booking(), { id: "text0001", kind: "text", heading: "Why talk", body: "Twenty minutes, no slides." }]).page;
  is("every word a reader reads, never the call's id", pageWords(page), ["Talk it through first", "Why talk", "Twenty minutes, no slides."]);
  const promise = keep([booking({ heading: "Make easy money with one call" })]).page;
  is("a promise of easy money in its heading is found by the Terms check", fastMoneyOnPage(pageWords(promise))?.field, "page");
  const translated = withWords(page, pageWords(page).map((w) => `ES ${w}`));
  is("a translation puts the heading back, the call untouched", translated.blocks[0], { id: "book0001", kind: "booking", product: "call000001", heading: "ES Talk it through first" });
  is("no heading, no words", pageWords(keep([booking({ heading: "" })]).page), []);
}

part("A translation that makes its heading too long keeps the block, untranslated (review of #2145)");
{
  const page = keep([booking({ heading: "x".repeat(95) }), { id: "text0001", kind: "text", heading: "Why talk", body: "Twenty minutes." }]).page;
  const longer = withWords(page, pageWords(page).map((w) => `${w} (translated)`));
  is("read again on its own, the longer heading would drop the block", parsePage(longer).blocks.some((b) => b.kind === "booking"), false);
  const kept = keepEveryBlock(page, longer);
  is("kept: the booking block as it was, in its place, counted, the other block translated", [kept.page.blocks.map((b) => b.kind), kept.page.blocks[0], kept.page.blocks[1].kind === "text" ? kept.page.blocks[1].heading : "", kept.untranslated], [["booking", "text"], page.blocks[0], "Why talk (translated)", 1]);
}

part("A copy into another store maps the call, or leaves the block out");
{
  const blocks: PageBlock[] = [{ ...(keep([booking()]).page.blocks[0] as PageBlock), saved: "sect000001" }, { id: "prod0001", kind: "product", heading: "", product: "ebook00001", note: "" }];
  const mapped = emptyBlocksLeft();
  const across = copiedBlocks(blocks, (id) => (id === "call000001" ? "callcopy01" : id), (id) => id, mapped);
  is("its call becomes the call's copy, with no tie to a saved section", [across[0], mapped.refs], [{ id: "book0001", kind: "booking", product: "callcopy01", heading: "Talk it through first" }, 0]);
  const left = emptyBlocksLeft();
  const without = copiedBlocks(blocks, (id) => (id === "call000001" ? "" : id), (id) => id, left);
  is("a call that is not copied (and calls are not, today): the block is left out and counted", [without.map((b) => b.kind), left.refs], [["product"], 1]);
  is("the page copied from is left as it was", blocks[0], { id: "book0001", kind: "booking", product: "call000001", heading: "Talk it through first", saved: "sect000001" });
}

part("The card: the call's own name, length and place");
const NOW = Date.UTC(2026, 10, 4, 12);
const weekly = (extra: Partial<CallSetup> = {}): CallSetup => ({
  kind: "weekly",
  minutes: 30,
  tz: "America/Los_Angeles",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 4,
  horizonDays: 30,
  bufferMinutes: 0,
  room: null,
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
  ...extra,
});
const live = (starts: number[]): CallSetup => ({ ...weekly(), kind: "live", weekly: [[], [], [], [], [], [], []], sessions: starts.map((start, i) => ({ id: `sess${i}`, start, minutes: 60, seats: 10, room: null })) });
const listing = (id: string, call: CallSetup | null, extra: Record<string, unknown> = {}): Listing => ({ id, title: "Intro call", summary: "", priceCents: 9_000, hidden: false, call, options: [], recurring: null, ...extra }) as unknown as Listing;
const b = bookingWords("en");
const w = wordsIn("en");
{
  const card = bookingCardOf(listing("call000001", weekly({ room: "https://meet.example.com/ana" })), "ana", "en", true, NOW);
  is("a call on weekly hours, online: its name, the booking page's own line, a link to its page", card, {
    title: "Intro call",
    line: b.oneLine(30, b.whereLink),
    href: "/@ana/book/call000001",
    pick: w.pickTime,
    colon: ": ",
    closed: "",
  });
  is("which says how long and where", card?.line, "30-minute call · online; you get the link when you book");
  is("a private video room is said as one", bookingCardOf(listing("call000001", weekly({ video: true })), "ana", "en", true, NOW)?.line, b.oneLine(30, b.whereVideo));
  is("a meeting on the creator's Zoom is said as one", bookingCardOf(listing("call000001", weekly({ meet: "zoom" })), "ana", "en", true, NOW)?.line, b.oneLine(30, b.whereMeet("Zoom")));
  is("no link yet: online", bookingCardOf(listing("call000001", weekly()), "ana", "en", true, NOW)?.line, b.oneOnline(30));
  const place = bookingCardOf(listing("call000001", weekly({ place: { lines: ["12 Elm Street", "Portland"] } })), "ana", "en", true, NOW);
  is("in person: the address, as the booking page says it", place?.line, b.inPersonLine(30, "12 Elm Street, Portland"));
  const group = bookingCardOf(listing("call000001", weekly({ seats: 8, room: "https://meet.example.com/ana" })), "ana", "en", true, NOW);
  is("a group call: never how many seats or people", [group?.line, /\b8\b|people|seat|left|spot/i.test(group?.line ?? "")], [b.oneLine(30, b.whereLink), false]);
  const sessions = bookingCardOf(listing("call000002", live([NOW + 3 * 86_400_000])), "ana", "en", true, NOW);
  is("dated sessions: picked as a session, with a link", [sessions?.pick, sessions?.href, sessions?.line], [w.pickSession, "/@ana/book/call000002", b.liveOnline]);
  const past = bookingCardOf(listing("call000002", live([NOW - 86_400_000, NOW + 3_600_000])), "ana", "en", true, NOW);
  is("none left before its notice: said in words, no link to an empty page", [past?.href, past?.closed], [null, w.noDates]);
  is("a draft: nothing", bookingCardOf(listing("call000001", weekly(), { hidden: true }), "ana", "en", true, NOW), null);
  is("not a call: nothing", bookingCardOf(listing("ebook00001", null), "ana", "en", true, NOW), null);
  is("not on sale: nothing", bookingCardOf(listing("call000001", weekly()), "ana", "en", false, NOW), null);
  for (const code of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    const there = bookingCardOf(listing("call000001", weekly({ video: true })), "ana", code, true, NOW);
    is(`in ${code}, the store's own words`, [there?.pick, there?.line, there?.colon], [wordsIn(code).pickTime, bookingWords(code).oneLine(30, bookingWords(code).whereVideo), bookingWords(code).colon]);
  }
}

part("The cards come from the listings the store already holds");
{
  const head = [
    listing("call000001", weekly()),
    listing("call000003", weekly(), { hidden: true }),
    listing("free000001", weekly(), { priceCents: 0, title: "Free intro" }),
    listing("ebook00001", null),
    listing("call000004", weekly(), { recurring: { interval: "month" } }),
  ];
  const store = (extra: Record<string, unknown> = {}) =>
    ({ handle: "ana", language: "en", catalog: { id: "c", items: [], head, inline: null }, stripeAccountId: "acct_synthetic", stripeChargesEnabled: true, subscriptionActive: true, suspended: false, ...extra }) as unknown as Store;
  const asked = ["call000001", "call000003", "free000001", "ebook00001", "call000004", "call000099"];
  const before = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("a store that cannot take payments: no card at all", bookingCards(store(), asked, NOW), {});
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_no_calls";
  const cards = bookingCards(store(), asked, NOW);
  is("only a call on sale: not a draft, not a free call yet (551 [FB1]), not a product, not a subscription, not one past the first page", Object.keys(cards), ["call000001"]);
  is("only the calls the page asks for", Object.keys(bookingCards(store(), ["ebook00001"], NOW)), []);
  is("a store switched off after notices: none", bookingCards(store({ suspended: true }), asked, NOW), {});
  is("read at once, with no request", bookingCards(store(), asked, NOW) instanceof Promise, false);
  if (before === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = before;
  // Read nothing: every command the store's database is sent and every request out are counted while the cards are made.
  const sent = { commands: 0, requests: 0 };
  const pipeline = redis.pipeline.bind(redis);
  const realFetch = globalThis.fetch;
  redis.pipeline = (commands: (string | number)[][]) => {
    sent.commands += commands.length;
    return pipeline(commands);
  };
  globalThis.fetch = (async () => {
    sent.requests += 1;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    bookingCards(store(), asked, NOW);
  } finally {
    redis.pipeline = pipeline;
    globalThis.fetch = realFetch;
  }
  is("made with no database command and no request out", sent, { commands: 0, requests: 0 });
}

part("Drawn on the page");
const ctx: BlockContext = { storeName: "Ana", productTitle: "Intro call", picture: null, photo: null, action: { kind: "link", href: "#buy" }, defaultLabel: "Get it now", lang: "en" };
const card = bookingCardOf(listing("call000001", weekly({ room: "https://meet.example.com/ana" })), "ana", "en", true, NOW)!;
const withCard = { ...ctx, bookings: { call000001: card } };
const draw = (block: PageBlock, context: BlockContext = withCard) => renderToStaticMarkup(createElement(BlockView, { block, ctx: context, reviews: null }));
const block = keep([booking()]).page.blocks[0] as PageBlock;
{
  const html = draw(block);
  is("the creator's heading, then the call's name and line", [html.includes(">Talk it through first</h2>"), html.includes(">Intro call</h3>"), html.includes(card.line)], [true, true, true]);
  is(
    "a link to the call's own booking page, whose name says where it leads (WCAG 2.4.9)",
    html.includes('<a href="/@ana/book/call000001" class="btn st-btn sp-cta-btn">Pick a time<span class="sr-only">: Intro call</span></a>'),
    true,
  );
  const css = readFileSync("app/globals.css", "utf8");
  const btn = /\n\.btn \{[^}]*min-height: (\d+)px/.exec(css);
  is("the theme's button, at least 44 pixels high (WCAG 2.5.5)", Number(btn?.[1] ?? 0) >= 44, true);
  is("no heading: the call's name is the heading", draw(keep([booking({ heading: "" })]).page.blocks[0] as PageBlock).includes(">Intro call</h2>"), true);
  is("a call with no card (gone, a draft, not a call, not on sale): nothing drawn", [draw(block, ctx), draw(block, { ...ctx, bookings: {} })], ["", ""]);
  is("an empty one: nothing drawn", draw(emptyBlock("booking", "book0009")), "");
  const closed = draw(block, { ...ctx, bookings: { call000001: { ...card, href: null, closed: w.noDates } } });
  is("no date on sale: said in words, with no link", [closed.includes("<a "), closed.includes(w.noDates)], [false, true]);
  const preview = draw(block, { ...withCard, preview: true });
  is("in the studio's preview the link does nothing", [preview.includes("href="), preview.includes("Pick a time")], [false, true]);
  const tag = draw(keep([booking({ heading: "<img src=x onerror=alert(1)>" })]).page.blocks[0] as PageBlock);
  is("a tag typed is drawn as text, never as markup", [tag.includes("<img"), tag.includes("&lt;img")], [false, true]);
  is("no hurry, no count of seats or bookings", /left|spots?\b|seats?\b|hurry|only \d|booked/i.test(html.replace(card.line, "")), false);
}

part("Not offered until its picker and editor exist");
is("not in the block list", BLOCK_KINDS.some((k) => k.kind === "booking"), false);
is("not in the gallery", BLOCK_GROUPS.some((g) => g.kinds.includes("booking")), false);
is("not on a store's own pages yet", SITE_KINDS.includes("booking"), false);
is("but it has an icon, like every kind", KIND_ICONS.booking, "calendar");
const editor = readFileSync("components/page-editor.tsx", "utf8");
is("the editor names one already on a page and tells back why one was not saved", [editor.includes('kind === "booking" ? "Booking"'), /\n {2}booking: `A page holds one booking block/.test(editor)], [true, true]);

done();
