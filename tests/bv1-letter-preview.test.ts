/**
 * A preview of an email kept for members (queue item 428 [BV1], added
 * 6 November 2026): lib/letter-rules.ts (previewOf, parseLetter),
 * lib/letters.ts (publishLetter), the email's page, the list, the route and
 * the words in every buyer language.
 *
 * Checked:
 *
 *   - the creator may show everyone the first one to LETTER_PREVIEW_MAX
 *     parts of an email kept for members; only a whole number in that range,
 *     only with products checked; anything else is refused, never widened;
 *   - a stored copy with a preview out of range, or without products, shows
 *     no preview (less, never more);
 *   - the preview never reaches the last part: at least one part stays for
 *     members, so a preview can never show the whole email;
 *   - a visitor sees the preview, the products and the form, never the words
 *     after it; a holder and the creator read the whole email;
 *   - the words after the preview never reach the list, the page's metadata
 *     or the page of somebody without the product;
 *   - an email with no preview chosen is exactly as before;
 *   - publishing again with nothing said keeps the preview.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, addProduct, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Broadcast } from "@/lib/broadcasts";
import { LETTER_PREVIEW_MAX, parseLetter, previewOf } from "@/lib/letter-rules";
import { publishLetter, readLetter } from "@/lib/letters";
import { mintPass, passCookieName } from "@/lib/learn";
import { letterWords } from "@/lib/buyer-words/letters";
import { LANGUAGE_CODES } from "@/lib/store-language";
import LetterPage, { generateMetadata } from "@/app/[handle]/letters/[letter]/page";
import LettersPage from "@/app/[handle]/letters/page";
import { POST as publishRoute } from "@/app/api/store/letters/route";
import { cookieValues } from "./letter-members-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_letter_preview_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only"; // one of the synthetic credentials the Resend fallback fixture knows (tests/resend-fixture-credentials.ts)

const OWNER = "letters-preview@example.com";
const HANDLE = "previewclub";
const ACCOUNT = "acct_1TestPreview001";
const NOW = Math.floor(Date.now() / 1000);
const HELLO = "A short hello to everyone on the list.";
const SECRET = "Members-only recipe: brown the butter for exactly four minutes.";
const STEP = "Step two of the secret";
const THANKS = "Thanks for reading.";
const BODY = ["# October recipes", HELLO, SECRET, `- ${STEP}`, THANKS].join("\n\n");

const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, product: string) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestPreview001",
  metadata: { store: HANDLE, product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
});

function broadcast(store: Store, id: string, over: Partial<Broadcast> = {}): Broadcast {
  const b: Broadcast = {
    id: id.padStart(24, "0"),
    listId: store.listId!,
    handle: store.handle,
    subject: "October for members",
    body: BODY,
    productId: null,
    notProductId: null,
    who: "all",
    narrow: null,
    status: "sent",
    createdAt: 1_760_000_000,
    sendAt: 1_760_000_100,
    finishedAt: 1_760_000_200,
    total: 12,
    sent: 12,
    note: "",
    failures: 0,
    listed: true,
    tagged: true,
    test: null,
    ...over,
  };
  redis.run(["SET", `nl:mail:bc:${b.id}`, JSON.stringify(b)]);
  return b;
}

async function render(store: Store, id: string, cookie: Record<string, string> = {}): Promise<string> {
  cookieValues.clear();
  for (const [k, v] of Object.entries(cookie)) cookieValues.set(k, v);
  const page = await LetterPage({ params: Promise.resolve({ handle: `@${store.handle}`, letter: id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(page);
}

const post = (owner: string, body: unknown) =>
  publishRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify(body) }));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Preview Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: `cus_${HANDLE}`, subscriptionId: `sub_${HANDLE}`, active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Butter Club", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const club = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();

  part("The rules: how much a preview may show");
  is("at most five parts", LETTER_PREVIEW_MAX, 5);
  const base = { id: "a".repeat(20), sid: "s1", subject: "Hi", body: BODY, sentAt: 1, publishedAt: 2 };
  is("a stored preview of 2 with products is kept", parseLetter({ ...base, products: [club], preview: 2 })?.preview, 2);
  for (const [what, wrong] of [["0", 0], ["6", 6], ["1.5", 1.5], ["-1", -1], ["a string", "2"], ["NaN", Number.NaN], ["null", null]] as [string, unknown][]) {
    const read = parseLetter({ ...base, products: [club], preview: wrong });
    is(`a stored preview of ${what} shows none, and the email stays kept`, [read?.preview, read?.products], [undefined, [club]]);
  }
  is("a stored preview without products is dropped (the email is open to all anyway)", parseLetter({ ...base, preview: 2 })?.preview, undefined);
  const two = parseLetter({ ...base, products: [club], preview: 2 })!;
  is("previewOf: the first two parts, as written", previewOf(two), `# October recipes\n\n${HELLO}`);
  is("never the words after them", [previewOf(two).includes(SECRET), previewOf(two).includes(STEP), previewOf(two).includes(THANKS)], [false, false, false]);
  const short = parseLetter({ ...base, body: `${HELLO}\n\n${SECRET}`, products: [club], preview: 5 })!;
  is("a preview longer than the email stops before its last part", previewOf(short), HELLO);
  const single = parseLetter({ ...base, body: SECRET, products: [club], preview: 3 })!;
  is("an email of one part shows no preview at all", previewOf(single), "");
  is("no preview chosen: nothing", previewOf(parseLetter({ ...base, products: [club] })!), "");
  is("an email open to all has no preview (everyone reads it whole)", previewOf(parseLetter(base)!), "");

  part("Publishing with a preview");
  const kept = broadcast(store, "b1");
  for (const [what, wrong] of [["6", 6], ["0.5", 0.5], ["-1", -1], ["a string", "2"], ["an array", [2]]] as [string, unknown][]) {
    const r = await publishLetter(store, kept, now, [club], false, wrong);
    is(`a preview of ${what} is refused`, [r.ok, r.ok ? "" : r.reason], [false, "preview"]);
  }
  const noProducts = await publishLetter(store, kept, now, [], false, 2);
  is("a preview with no product checked is refused (everyone would read it whole)", [noProducts.ok, noProducts.ok ? "" : noProducts.reason], [false, "preview"]);
  const plain = await publishLetter(store, broadcast(store, "b0"), now, [club]);
  is("no preview said: the same copy as before", plain.ok ? Object.keys(plain.letter).sort() : [], ["body", "id", "products", "publishedAt", "sentAt", "sid", "subject"]);
  const zero = await publishLetter(store, broadcast(store, "b9"), now, [club], false, 0);
  is("a preview of 0 is no preview", zero.ok ? zero.letter.preview : "refused", undefined);
  const published = await publishLetter(store, kept, now, [club], false, 2);
  if (!published.ok) throw new Error(published.message);
  const letter = published.letter;
  is("kept for members with a preview of 2", [letter.products, letter.preview], [[club], 2]);
  is("read back the same", (await readLetter(store, letter.id))?.preview, 2);
  const again = await publishLetter(store, kept, now + 1);
  is("published again with nothing said: the products and the preview stay", again.ok ? [again.letter.products, again.letter.preview] : null, [[club], 2]);
  const changed = await publishLetter(store, kept, now + 2, [club], false, 1);
  is("or a new preview is taken", changed.ok ? changed.letter.preview : null, 1);
  const dropped = await publishLetter(store, kept, now + 3, [club]);
  is("and products given with no preview take it off", dropped.ok ? dropped.letter.preview : "refused", undefined);
  await publishLetter(store, kept, now + 4, [club], false, 2);

  part("Who sees what on the page");
  const owner = await openSession(OWNER);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  const anaPass = await mintPass(store, "ana@example.com", "all");
  const outHtml = await render(store, letter.id);
  is("a visitor sees the preview: the heading and the hello", [outHtml.includes("October recipes"), outHtml.includes(HELLO)], [true, true]);
  is("and is told it is the start", outHtml.includes(letterWords("en").previewHeading), true);
  is("never the words after it", [outHtml.includes(SECRET), outHtml.includes(STEP), outHtml.includes(THANKS)], [false, false, false]);
  is("the products and the form are still there", [outHtml.includes("Butter Club"), outHtml.includes("/api/store/letters/link")], [true, true]);
  const inHtml = await render(store, letter.id, { [passCookieName(store)]: anaPass });
  is("a holder reads the whole email, once, with no preview label", [inHtml.includes(SECRET), inHtml.includes(THANKS), inHtml.split(HELLO).length - 1, inHtml.includes(letterWords("en").previewHeading)], [true, true, 1, false]);
  const ownerHtml = await render(store, letter.id, { [SESSION_COOKIE]: owner });
  is("the creator reads it whole and is told what everyone sees", [ownerHtml.includes(SECRET), ownerHtml.includes(letterWords("en").ownerPreviewNote(2))], [true, true]);
  const plainHtml = plain.ok ? await render(store, plain.letter.id) : "";
  is("an email kept with no preview shows a visitor no words, as before", [plainHtml.includes(HELLO), plainHtml.includes(letterWords("en").previewHeading)], [false, false]);

  part("The words after the preview reach no public place");
  const list = renderToStaticMarkup(await LettersPage({ params: Promise.resolve({ handle: `@${HANDLE}` }) }));
  is("the list shows neither the preview nor the words", [list.includes(HELLO), list.includes(SECRET)], [false, false]);
  const meta = JSON.stringify(await generateMetadata({ params: Promise.resolve({ handle: `@${HANDLE}`, letter: letter.id }), searchParams: Promise.resolve({}) }));
  is("the metadata holds neither", [meta.includes(HELLO), meta.includes(SECRET)], [false, false]);

  part("The route");
  const viaRoute = await post(owner, { action: "publish", id: kept.id, products: [club], preview: 3 });
  is("takes a preview with the products", [viaRoute.status, (await readLetter(store, letter.id))?.preview], [200, 3]);
  const badRoute = await post(owner, { action: "publish", id: kept.id, products: [club], preview: 9 });
  is("refuses one out of range, and the kept one stays", [badRoute.status, ((await badRoute.json()) as { error?: string }).error, (await readLetter(store, letter.id))?.preview], [409, "preview", 3]);

  part("The words in every buyer language");
  for (const code of LANGUAGE_CODES) {
    const w = letterWords(code);
    const ok = typeof w.previewHeading === "string" && w.previewHeading.trim().length > 0 && w.ownerPreviewNote(2).includes("2");
    is(`${code}: the preview's heading and the creator's note`, ok, true);
    if (code !== "en") is(`${code}: in its own words`, w.previewHeading !== letterWords("en").previewHeading, true);
  }
  part("J: unknown kept-record reads never open members-only words");
  for (const mode of ["missing-slot", "boolean-slot", "empty-envelope", "control"] as const) {
    await publishLetter(store, kept, now + 10, [club], false, 2);
    const pipeline = redis.pipeline.bind(redis);
    let injected = false;
    redis.pipeline = async (commands) => {
      const replies = await pipeline(commands);
      if (!injected && commands.length === 4 && commands[3]?.[0] === "GET" && commands[3]?.[1] === `nl:letters:i:${letter.id}`) {
        injected = true;
        if (mode === "missing-slot") return replies.slice(0, 3);
        if (mode === "boolean-slot") return [replies[0], replies[1], replies[2], false];
        if (mode === "empty-envelope") return [];
      }
      return replies;
    };
    try {
      await publishLetter(store, kept, now + 11);
    } finally {
      redis.pipeline = pipeline;
    }
    if (!injected) throw Error("kept-record read not reached");
    const actual = await readLetter(store, letter.id);
    is(`${mode}: original member products remain`, actual?.products, [club]);
    const visitor = await render(store, letter.id);
    is(`${mode}: visitor never sees the private recipe`, visitor.includes(SECRET), false);
  }
  // The same reader on the other path (Claude 2, with Codex J's finding): an empty choice that does not say open,
  // over an email kept for members, is refused only if the list's score says so. An unknown score must refuse too.
  part("Unknown list scores never open members-only words");
  for (const mode of ["missing-score", "boolean-score", "word-score", "control"] as const) {
    await publishLetter(store, kept, now + 20, [club], false, 2);
    const pipeline = redis.pipeline.bind(redis);
    let injected = false;
    redis.pipeline = async (commands) => {
      const replies = await pipeline(commands);
      if (!injected && commands.length === 3 && commands[2]?.[0] === "ZSCORE") {
        injected = true;
        if (mode === "missing-score") return replies.slice(0, 2);
        if (mode === "boolean-score") return [replies[0], replies[1], true];
        if (mode === "word-score") return [replies[0], replies[1], "kept"];
      }
      return replies;
    };
    let r: Awaited<ReturnType<typeof publishLetter>>;
    try {
      r = await publishLetter(store, kept, now + 21, []);
    } finally {
      redis.pipeline = pipeline;
    }
    if (!injected) throw Error("score read not reached");
    is(`${mode}: refused`, r.ok, false);
    is(`${mode}: the products and the preview stay`, [(await readLetter(store, letter.id))?.products, (await readLetter(store, letter.id))?.preview], [[club], 2]);
    is(`${mode}: a visitor never sees the private recipe`, (await render(store, letter.id)).includes(SECRET), false);
  }
  part("J: missing copy with a surviving members-only score");
  await publishLetter(store, kept, now + 30, [club], false, 2);
  await redis.pipeline([["DEL", `nl:letters:i:${letter.id}`]]);
  const missing = await publishLetter(store, kept, now + 31);
  is("a missing member copy refuses republication", missing.ok, false);
  // With the copy gone and the republish refused, the page has nothing to show and answers 404: no words at all.
  const afterMissing = await render(store, letter.id).catch((e: unknown) => (String((e as { digest?: unknown })?.digest ?? "").endsWith(";404") ? "" : Promise.reject(e)));
  is("a visitor never reads the private recipe after missing-copy republication", afterMissing.includes(SECRET), false);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
