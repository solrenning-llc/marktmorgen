/**
 * Blog posts kept for members (queue items 28 [E11] and 100
 * [E2-MEMBER-PUBLICATIONS], unit 2, added 4 November 2026): lib/store-blog.ts,
 * the studio's route, the post's page, the blog's list, its feed, the store's
 * sitemap and the "Send me the link" route, on the door published emails use
 * (lib/letter-access.ts), against a stand-in for the creator's Stripe account
 * and the email service.
 *
 * Checked:
 *
 *   - the creator chooses the products when saving; only this store's
 *     products, at most MAX_LETTER_PRODUCTS; a wrong kind of choice is
 *     refused; saved again without products, a post stays kept; only an
 *     empty list sent on purpose opens it;
 *   - a post with nothing chosen is exactly as before;
 *   - the words show only to the creator and to a proved address that holds
 *     a product now; a refund in full, a dispute lost and a membership that
 *     ended close it once the kept answer runs out;
 *   - the emailed link is sent only to an address that holds a product, the
 *     form answers the same either way, also with the email service down,
 *     and opening it lets the browser in and goes back to the post;
 *   - the words and their first lines never reach the list, the feed, the
 *     sitemap, the page's metadata or any other public place.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_LETTER_PRODUCTS } from "@/lib/letter-rules";
import { memberReader } from "@/lib/letter-access";
import { mintPass, passCookieName } from "@/lib/learn";
import { postSegment, publishedPosts, readPost } from "@/lib/store-blog";
import { storeSitemap } from "@/lib/store-sitemap";
import PostPage, { generateMetadata } from "@/app/[handle]/blog/[post]/page";
import BlogPage from "@/app/[handle]/blog/page";
import { GET as feedRoute } from "@/app/[handle]/blog/feed.xml/route";
import { POST as blogRoute } from "@/app/api/store/blog/route";
import { POST as linkRoute } from "@/app/api/store/blog/link/route";
import { GET as openRoute } from "@/app/api/store/letters/open/route";
import { cookieValues } from "./letter-members-world";
import { afterTasks } from "./next-server-after-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_blog_members_only";
process.env.RESEND_API_KEY = "re_test_blog_members_stand_in";

const OWNER = "blog-members@example.com";
const HANDLE = "rivabakes";
const ACCOUNT = "acct_1TestBlogMem001";
const NOW = Math.floor(Date.now() / 1000);
const SECRET = "Members-only method: fold the dough twelve times before it rests.";
const OPEN_WORDS = "Everyone may read these bread notes.";

const sessions: Record<string, Record<string, unknown>[]> = {};
const mails: { to: string; text: string }[] = [];
let stripeAsked = 0;
let mailDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (mailDown) return answer({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    mails.push({ to: [body.to].flat()[0], text: body.text });
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  stripeAsked += 1;
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (over: Record<string, unknown> = {}) => ({ object: "charge", id: "ch_TestBlogCharge01", amount: 4900, amount_refunded: 0, refunded: false, ...over });
const paid = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestBlogReader01",
  metadata: { store: HANDLE, product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: charge(over) },
});
const member = (id: string, product: string, status: string) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestBlogMember1",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status },
});

const jar = (values: Record<string, string>) => ({ get: (name: string) => (name in values ? { value: values[name] } : undefined) });
const forgetAnswers = () => {
  for (const key of redis.keys().filter((k) => k.startsWith("nl:letters:ok:"))) redis.run(["DEL", key]);
};

async function render(store: Store, segment: string, cookie: Record<string, string> = {}, query: Record<string, string> = {}): Promise<string> {
  cookieValues.clear();
  for (const [k, v] of Object.entries(cookie)) cookieValues.set(k, v);
  const page = await PostPage({ params: Promise.resolve({ handle: `@${store.handle}`, post: segment }), searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(page);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Riva Bakes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: `cus_${HANDLE}`, subscriptionId: `sub_${HANDLE}`, active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Dough Club", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const club = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const owner = await openSession(OWNER);

  const save = async (payload: Record<string, unknown>) => {
    const r = await blogRoute(
      new NextRequest("https://marktmorgen.com/api/store/blog", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify({ action: "save", draft: false, ...payload }) }),
    );
    return { status: r.status, body: (await r.json()) as { ok?: boolean; error?: string; post?: { id: string; title: string; products?: string[]; excerpt: string } } };
  };

  part("The creator chooses the products when saving");
  const refused = await save({ title: "Folding for members", body: SECRET, products: ["nope_not_a_product"] });
  is("a product this store does not have is refused", [refused.status, refused.body.error], [400, "products"]);
  const tooMany = await save({ title: "Folding for members", body: SECRET, products: Array.from({ length: MAX_LETTER_PRODUCTS + 1 }, () => club) });
  is(`more than ${MAX_LETTER_PRODUCTS} given is refused`, [tooMany.status, tooMany.body.error], [400, "products"]);
  const first = await save({ title: "Folding for members", body: SECRET, products: [club] });
  if (!first.body.ok || !first.body.post) throw new Error(`not saved: ${JSON.stringify(first.body)}`);
  const id = first.body.post.id;
  const segment = postSegment(first.body.post);
  const kept = async () => (await readPost(store.statsId, id))?.products;
  is("kept for the holders of the product checked", await kept(), [club]);
  is("its first lines are kept nowhere a list reads", first.body.post.excerpt, "");

  part("A wrong kind of choice never opens a post");
  for (const [what, wrong] of [["a string", club], ["an object", { 0: club }], ["a number", 1], ["true", true]] as [string, unknown][]) {
    const r = await save({ id, title: "Folding for members", body: SECRET, products: wrong });
    is(`${what} is refused, and the post stays kept`, [r.status, r.body.error, await kept()], [400, "products", [club]]);
  }
  const again = await save({ id, title: "Folding for members", body: SECRET });
  is("saved again with no products said: still kept for members", [again.body.ok, await kept()], [true, [club]]);
  const againNull = await save({ id, title: "Folding for members", body: SECRET, products: null });
  is("or with null", [againNull.body.ok, await kept()], [true, [club]]);
  const asDraft = await save({ id, title: "Folding for members", body: SECRET, draft: true });
  is("or as a draft", [asDraft.body.ok, await kept()], [true, [club]]);
  await save({ id, title: "Folding for members", body: SECRET });
  const toAll = await save({ id, title: "Folding for members", body: SECRET, products: [] });
  is("only an empty choice, on purpose, opens it to everyone", [toAll.body.ok, await kept(), toAll.body.post?.excerpt], [true, undefined, SECRET]);
  const back = await save({ id, title: "Folding for members", body: SECRET, products: [club] });
  is("and checking the product again keeps it again, its first lines gone again", [await kept(), back.body.post?.excerpt], [[club], ""]);

  part("Nothing chosen: a post is as before");
  const open = await save({ title: "Open bread notes", body: OPEN_WORDS });
  if (!open.body.ok || !open.body.post) throw new Error("not saved");
  const openSegment = postSegment(open.body.post);
  const openPost = (await readPost(store.statsId, open.body.post.id))!;
  is("no products field, its first lines kept as before", [Object.keys(openPost).sort(), openPost.excerpt], [["body", "draft", "excerpt", "id", "minutes", "product", "publishedAt", "title", "updatedAt"], OPEN_WORDS]);
  is("everyone reads it", (await memberReader(store, openPost.products, jar({}))).state, "public");
  const openHtml = await render(store, openSegment);
  is("its page shows its words, no form, no members label", [openHtml.includes(OPEN_WORDS), openHtml.includes("/api/store/blog/link"), openHtml.includes("For members")], [true, false, false]);
  const openMeta = await generateMetadata({ params: Promise.resolve({ handle: `@${HANDLE}`, post: openSegment }), searchParams: Promise.resolve({}) });
  is("its metadata as before: its first lines, no robots line", [openMeta.description, openMeta.robots], [OPEN_WORDS, undefined]);

  part("Kept for members: who sees the words");
  const cookieName = passCookieName(store);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  sessions["ben@example.com"] = [paid("cs_test_ben000000001", club, { amount_refunded: 4900, refunded: true })];
  const anaPass = await mintPass(store, "ana@example.com", "all");
  const benPass = await mintPass(store, "ben@example.com", "all");
  const coursePass = await mintPass(store, "ana@example.com", ["c".repeat(32)]);
  const post = (await readPost(store.statsId, id))!;
  const state = async (cookie: Record<string, string>) => (await memberReader(store, post.products, jar(cookie))).state;
  is("a visitor nobody knows is asked to prove the address", await state({}), "out");
  is("a pass for one course only is not proof enough", await state({ [cookieName]: coursePass }), "out");
  is("a proved holder reads it", await state({ [cookieName]: anaPass }), "in");
  is("a proved address refunded in full does not", await state({ [cookieName]: benPass }), "closed");
  is("the creator always does", await state({ [SESSION_COOKIE]: owner }), "owner");

  const outHtml = await render(store, segment);
  is(
    "without the product: title, date, \"For members\", the product linked and the form, never the words",
    [outHtml.includes("Folding for members"), outHtml.includes("<time"), outHtml.includes("For members"), outHtml.includes("Dough Club"), outHtml.includes(`/@${HANDLE}/p/`), outHtml.includes("/api/store/blog/link"), outHtml.includes(SECRET)],
    [true, true, true, true, true, true, false],
  );
  const closedHtml = await render(store, segment, { [cookieName]: benPass });
  is("an address that holds nothing is told so, never shown the words", [closedHtml.includes("This address has none of these products"), closedHtml.includes("open this post"), closedHtml.includes(SECRET)], [true, true, false]);
  const inHtml = await render(store, segment, { [cookieName]: anaPass });
  is("a holder reads the words, and no form", [inHtml.includes(SECRET), inHtml.includes("/api/store/blog/link")], [true, false]);
  const ownerHtml = await render(store, segment, { [SESSION_COOKIE]: owner });
  is("the creator reads them, told who else can", [ownerHtml.includes(SECRET), ownerHtml.includes("Only you and people who have one of these products")], [true, true]);

  part("A refund, a lost dispute or an ended membership closes it");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club, { amount_refunded: 4900, refunded: true })];
  is("kept answer: still open for its few minutes", await state({ [cookieName]: anaPass }), "in");
  forgetAnswers();
  is("refunded, asked again: closed", await state({ [cookieName]: anaPass }), "closed");
  is("and the page no longer shows the words", (await render(store, segment, { [cookieName]: anaPass })).includes(SECRET), false);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club, { disputed: true, dispute: { status: "lost", amount: 4900 } })];
  forgetAnswers();
  is("a dispute lost: closed", await state({ [cookieName]: anaPass }), "closed");
  sessions["ana@example.com"] = [member("cs_test_ana000000002", club, "active")];
  forgetAnswers();
  is("a membership running: open", await state({ [cookieName]: anaPass }), "in");
  sessions["ana@example.com"] = [member("cs_test_ana000000002", club, "canceled")];
  forgetAnswers();
  is("the membership ended: closed", await state({ [cookieName]: anaPass }), "closed");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  forgetAnswers();

  part("The emailed link: the same answer, at once, whoever asks");
  const ask = async (email: string, ip: string, postId = id) => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("post", postId);
    form.set("email", email);
    const r = await linkRoute(new NextRequest("https://marktmorgen.com/api/store/blog/link", { method: "POST", body: form, headers: { "x-forwarded-for": ip } }));
    return { status: r.status, location: r.headers.get("location") ?? "" };
  };
  const grants = () => redis.keys().filter((k) => k.startsWith("nl:letters:link:") && !k.endsWith(":opens")).length;
  const runAfter = async () => {
    for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  };
  afterTasks.length = 0;
  const atAnswer = async (email: string, ip: string) => {
    forgetAnswers();
    const [asked, sent, made] = [stripeAsked, mails.length, grants()];
    const r = await ask(email, ip);
    return [r.status, r.location.endsWith(`/@${HANDLE}/blog/${segment}?link=sent`), stripeAsked - asked, mails.length - sent, grants() - made, afterTasks.length];
  };
  const before = mails.length;
  is("an address that holds nothing: \"sent\" at once, nothing asked or sent before the answer", await atAnswer("nobody@example.com", "203.0.113.7"), [303, true, 0, 0, 0, 1]);
  await runAfter();
  is("and after it, no email", mails.length, before);
  is("a holder: the very same answer, the same nothing done before it", await atAnswer("ana@example.com", "203.0.113.7"), [303, true, 0, 0, 0, 1]);
  await runAfter();
  is("and after it, one email to it", [mails.length, mails.at(-1)?.to], [before + 1, "ana@example.com"]);
  is("the email holds a link to open and the post's title, never the words", [/\/api\/store\/letters\/open\?token=[0-9a-f]{64}/.test(mails.at(-1)?.text ?? ""), (mails.at(-1)?.text ?? "").includes("Folding for members"), (mails.at(-1)?.text ?? "").includes(SECRET)], [true, true, false]);
  mailDown = true;
  const downHolder = await atAnswer("ana@example.com", "203.0.113.10");
  await runAfter();
  const downStranger = await atAnswer("nobody@example.com", "203.0.113.10");
  await runAfter();
  is("with the email service down, the holder's answer and a stranger's are the same", [downHolder, downStranger], [[303, true, 0, 0, 0, 1], [303, true, 0, 0, 0, 1]]);
  mailDown = false;
  const ipKey = (ip: string) => `nl:letters:rl:ip:${createHash("sha256").update(`${ip}|${HANDLE}`).digest("hex").slice(0, 32)}`;
  is("its asks are counted under the same limits, which always end", [redis.run(["GET", ipKey("203.0.113.10")]), Number(redis.run(["TTL", ipKey("203.0.113.10")])) > 0], ["2", true]);
  const bad = await ask("not an address", "203.0.113.12");
  is("a mistyped address is said at once", bad.location.endsWith("?link=email"), true);
  is("asking for a link to a post everyone can read is refused", (await ask("ana@example.com", "203.0.113.9", open.body.post.id)).status, 404);
  is("and to a post that is not there", (await ask("ana@example.com", "203.0.113.9", "0123456789")).status, 404);

  const token = /token=([0-9a-f]{64})/.exec(mails.at(-1)!.text)![1];
  const opened = await openRoute(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${token}`));
  const set = opened.headers.get("set-cookie") ?? "";
  is("opening it lets this browser in and goes back to the post", [opened.status, (opened.headers.get("location") ?? "").endsWith(`/@${HANDLE}/blog/${id}`), set.startsWith(`${cookieName}=`)], [303, true, true]);
  const minted = /=([0-9a-f]{64})/.exec(set)![1];
  is("with it, the words show", (await render(store, segment, { [cookieName]: minted })).includes(SECRET), true);
  is("the page says to check the inbox, for a post", (await render(store, segment, {}, { link: "sent" })).includes("a link to read this post is on its way"), true);

  part("Nowhere public: the list, the feed, the sitemap, the metadata");
  cookieValues.clear();
  const fresh = (await storeForEmail(OWNER))!;
  const list = renderToStaticMarkup(await BlogPage({ params: Promise.resolve({ handle: `@${HANDLE}` }) }));
  is("the list shows the title and says it is for members, never the words", [list.includes("Folding for members"), list.includes("For members"), list.includes(SECRET), list.includes(OPEN_WORDS)], [true, true, false, true]);
  const { posts } = await publishedPosts(fresh.statsId, 1);
  is("what the list reads holds no first lines of it", posts.find((p) => p.id === id)?.excerpt, "");
  const feed = await (await feedRoute(new Request(`https://marktmorgen.com/@${HANDLE}/blog/feed.xml`), { params: Promise.resolve({ handle: `@${HANDLE}` }) })).text();
  is("the feed names it, for members, never its words", [feed.includes("Folding for members"), feed.includes("For members"), feed.includes(SECRET), feed.includes(OPEN_WORDS)], [true, true, false, true]);
  const map = (await storeSitemap(fresh)).map((e) => e.url);
  is("the sitemap leaves it out and keeps the public post", [map.some((u) => u.endsWith(segment)), map.some((u) => u.endsWith(openSegment))], [false, true]);
  const meta = await generateMetadata({ params: Promise.resolve({ handle: `@${HANDLE}`, post: segment }), searchParams: Promise.resolve({}) });
  is(
    "the page's metadata: the title only, kept from search engines",
    [JSON.stringify(meta).includes(SECRET), meta.description, meta.robots && typeof meta.robots === "object" ? (meta.robots as { index?: boolean }).index : true, String(meta.title).includes("Folding for members")],
    [false, undefined, false, true],
  );
  is("no structured data for it on the page a visitor gets; a public post keeps its own", [outHtml.includes("BlogPosting"), openHtml.includes("BlogPosting")], [false, true]);

  const root = process.cwd();
  const readers = ["app", "lib", "components"]
    .flatMap((dir) => filesUnder(join(root, dir)))
    .filter((file) => /from "@\/lib\/store-blog"|nl:blog:/.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(root.length + 1))
    .sort();
  is(
    "only these read the posts: no assistant, automatic answers or other public page",
    readers,
    [
      "app/[handle]/blog/[post]/page.tsx",
      "app/[handle]/blog/feed.xml/route.ts",
      "app/[handle]/blog/page.tsx",
      "app/api/store/blog/link/route.ts",
      "app/api/store/blog/route.ts",
      "app/studio/blog/page.tsx",
      "components/blog-body.tsx",
      "lib/data-families.ts",
      "lib/demo-seed.ts",
      "lib/store-blog.ts",
      "lib/store-export.ts",
      "lib/store-sitemap.ts",
    ],
  );
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
