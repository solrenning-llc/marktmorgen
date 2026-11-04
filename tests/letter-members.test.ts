/**
 * Published emails kept for members (queue items 28 [E11] and 100
 * [E2-MEMBER-PUBLICATIONS], unit 1, added 4 November 2026): lib/letter-rules.ts,
 * lib/letters.ts, lib/letter-access.ts, the email's page, the list and the
 * routes, against a stand-in for the creator's Stripe account and the email
 * service.
 *
 * Checked:
 *
 *   - the creator chooses the products when publishing; only this store's
 *     products, at most MAX_LETTER_PRODUCTS; nothing chosen keeps an email
 *     exactly as it was (everyone reads it, the same copy, the same page);
 *   - the page shows the words only to the creator and to a proved address
 *     that holds a product now; a visitor, a pass for one course only and an
 *     address that holds nothing see the subject, who it is for and the form;
 *   - a refund in full closes it once the kept answer runs out;
 *   - the emailed link is sent only to an address that holds a product, the
 *     form answers the same either way, and opening it lets the browser in;
 *   - the words never reach the list, the page's metadata, or any public
 *     place: only the pages, the studio, its routes and the closing walk
 *     read the copies.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, removeProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Broadcast } from "@/lib/broadcasts";
import { MAX_LETTER_PRODUCTS, membersOnly, parseLetter } from "@/lib/letter-rules";
import { listLetters, publishLetter, readLetter } from "@/lib/letters";
import { letterReader } from "@/lib/letter-access";
import { mintPass, passCookieName } from "@/lib/learn";
import LetterPage, { generateMetadata } from "@/app/[handle]/letters/[letter]/page";
import LettersPage from "@/app/[handle]/letters/page";
import { POST as publishRoute } from "@/app/api/store/letters/route";
import { POST as linkRoute } from "@/app/api/store/letters/link/route";
import { GET as openRoute } from "@/app/api/store/letters/open/route";
import { cookieValues } from "./letter-members-world";
import { afterTasks } from "./next-server-after-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_letter_members_only";
process.env.RESEND_API_KEY = "re_test_letter_members_stand_in";

const OWNER = "letters-members@example.com";
const HANDLE = "maraclub";
const ACCOUNT = "acct_1TestLetters001";
const NOW = Math.floor(Date.now() / 1000);
const SECRET = "Members-only recipe: brown the butter for exactly four minutes.";

const sessions: Record<string, Record<string, unknown>[]> = {};
const mails: { to: string; text: string }[] = [];
/** How often the creator's Stripe account was asked, and whether the email service is down. */
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

const charge = (amount: number, back: number) => ({ object: "charge", amount, amount_refunded: back, refunded: back >= amount });
const paid = (id: string, product: string, back = 0) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestReader001",
  metadata: { store: HANDLE, product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: charge(4900, back) },
});

function broadcast(store: Store, id: string, over: Partial<Broadcast> = {}): Broadcast {
  const b: Broadcast = {
    id: id.padStart(24, "0"),
    listId: store.listId!,
    handle: store.handle,
    subject: "October for members",
    body: SECRET,
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

const jar = (values: Record<string, string>) => ({ get: (name: string) => (name in values ? { value: values[name] } : undefined) });
const forgetAnswers = () => {
  for (const key of redis.keys().filter((k) => k.startsWith("nl:letters:ok:"))) redis.run(["DEL", key]);
};

async function render(store: Store, id: string, cookie: Record<string, string> = {}, query: Record<string, string> = {}): Promise<string> {
  cookieValues.clear();
  for (const [k, v] of Object.entries(cookie)) cookieValues.set(k, v);
  const page = await LetterPage({ params: Promise.resolve({ handle: `@${store.handle}`, letter: id }), searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(page);
}

/** Every file under a folder, for the check of who reads the copies. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Mara's Club", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: `cus_${HANDLE}`, subscriptionId: `sub_${HANDLE}`, active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Butter Club", "", "49", null);
  const other = await addProduct(OWNER, "Knife Skills", "", "29", null);
  if (!made.ok || !other.ok) throw new Error("no products");
  const club = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();

  part("The creator chooses the products when publishing");
  const kept = broadcast(store, "a1");
  const refused = await publishLetter(store, kept, now, ["nope_not_a_product"]);
  is("a product this store does not have is refused", [refused.ok, refused.ok ? "" : refused.reason], [false, "products"]);
  const tooMany = await publishLetter(store, kept, now, Array.from({ length: MAX_LETTER_PRODUCTS + 1 }, () => club));
  is(`more than ${MAX_LETTER_PRODUCTS} given is refused`, tooMany.ok, false);
  const published = await publishLetter(store, kept, now, [club]);
  if (!published.ok) throw new Error(published.message);
  const letter = published.letter;
  is("kept for the holders of the product checked", [membersOnly(letter), letter.products], [true, [club]]);
  is("read back the same", (await readLetter(store, letter.id))?.products, [club]);
  is("a stored copy naming products none readable stays closed, never opened to all", parseLetter({ ...letter, products: ["<bad>"] }), null);

  part("A wrong kind of choice never publishes for everyone");
  for (const [what, wrong] of [["a string", club], ["an object", { 0: club }], ["a number", 1]] as [string, unknown][]) {
    const r = await publishLetter(store, kept, now, wrong);
    is(`${what} is refused, and the email stays kept`, [r.ok, r.ok ? "" : r.reason, (await readLetter(store, letter.id))?.products], [false, "products", [club]]);
  }
  const again = await publishLetter(store, kept, now + 1);
  is("published again with no products said: still kept for members", again.ok ? again.letter.products : null, [club]);
  const againNull = await publishLetter(store, kept, now + 2, null);
  is("or with null", againNull.ok ? againNull.letter.products : null, [club]);
  const toAll = await publishLetter(store, kept, now + 3, []);
  is("only an empty choice, on purpose, opens it to everyone", [toAll.ok, toAll.ok ? membersOnly(toAll.letter) : true], [true, false]);
  const back = await publishLetter(store, kept, now + 4, [club]);
  is("and checking the product again keeps it again", back.ok ? back.letter.products : null, [club]);

  part("Nothing chosen: everyone reads it, as before");
  const open = await publishLetter(store, broadcast(store, "b1", { subject: "Open notes", body: "Everyone may read this." }), now);
  if (!open.ok) throw new Error(open.message);
  is("the same copy as before, with no products field", Object.keys(open.letter).sort(), ["body", "id", "publishedAt", "sentAt", "sid", "subject"]);
  is("everyone reads it", (await letterReader(store, open.letter, jar({}))).state, "public");
  const openHtml = await render(store, open.letter.id);
  is("its page shows its words, no form, no members label", [openHtml.includes("Everyone may read this."), openHtml.includes("/api/store/letters/link"), openHtml.includes("For members")], [true, false, false]);

  part("Kept for members: who sees the words");
  const pass = (email: string, scope: string[] | "all") => mintPass(store, email, scope);
  const cookieName = passCookieName(store);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  sessions["ben@example.com"] = [paid("cs_test_ben000000001", club, 4900)];
  const anaPass = await pass("ana@example.com", "all");
  const benPass = await pass("ben@example.com", "all");
  const coursePass = await pass("ana@example.com", ["c".repeat(32)]);
  const owner = await openSession(OWNER);
  is("a visitor nobody knows is asked to prove the address", (await letterReader(store, letter, jar({}))).state, "out");
  is("a pass for one course only is not proof enough", (await letterReader(store, letter, jar({ [cookieName]: coursePass }))).state, "out");
  is("a proved holder reads it", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "in");
  is("a proved address refunded in full does not", (await letterReader(store, letter, jar({ [cookieName]: benPass }))).state, "closed");
  is("the creator always does", (await letterReader(store, letter, jar({ [SESSION_COOKIE]: owner }))).state, "owner");

  const outHtml = await render(store, letter.id);
  is("without the product: subject, who it is for and the form, never the words", [outHtml.includes("October for members"), outHtml.includes("Butter Club"), outHtml.includes("/api/store/letters/link"), outHtml.includes(SECRET)], [true, true, true, false]);
  is("the product is linked", outHtml.includes(`/@${HANDLE}/p/`), true);
  const closedHtml = await render(store, letter.id, { [cookieName]: benPass });
  is("an address that holds nothing is told so, never shown the words", [closedHtml.includes("This address has none of these products"), closedHtml.includes(SECRET)], [true, false]);
  const inHtml = await render(store, letter.id, { [cookieName]: anaPass });
  is("a holder reads the words, and no form", [inHtml.includes(SECRET), inHtml.includes("/api/store/letters/link")], [true, false]);
  const ownerHtml = await render(store, letter.id, { [SESSION_COOKIE]: owner });
  is("the creator reads them, told who else can", [ownerHtml.includes(SECRET), ownerHtml.includes("Only you and people who have one of these products")], [true, true]);

  part("A refund in full closes it");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club, 4900)];
  is("kept answer: still open for its few minutes", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "in");
  forgetAnswers();
  is("asked again: closed", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "closed");
  is("and the page no longer shows the words", (await render(store, letter.id, { [cookieName]: anaPass })).includes(SECRET), false);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  forgetAnswers();

  part("The emailed link: the same answer, at once, whoever asks");
  const ask = async (email: string, ip = "203.0.113.7") => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("letter", letter.id);
    form.set("email", email);
    const r = await linkRoute(new NextRequest("https://marktmorgen.com/api/store/letters/link", { method: "POST", body: form, headers: { "x-forwarded-for": ip } }));
    return { status: r.status, location: r.headers.get("location") ?? "" };
  };
  const grants = () => redis.keys().filter((k) => k.startsWith("nl:letters:link:") && !k.endsWith(":opens")).length;
  const runAfter = async () => {
    for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  };
  afterTasks.length = 0;
  /** One request, and what was done before its answer: Stripe asked, emails sent, links made, work left for after it. */
  const atAnswer = async (email: string, ip: string) => {
    forgetAnswers();
    const [asked, sent, made] = [stripeAsked, mails.length, grants()];
    const r = await ask(email, ip);
    return [r.status, r.location.endsWith("?link=sent"), stripeAsked - asked, mails.length - sent, grants() - made, afterTasks.length];
  };
  const before = mails.length;
  is("an address that holds nothing: \"sent\" at once, nothing asked or sent before the answer", await atAnswer("nobody@example.com", "203.0.113.7"), [303, true, 0, 0, 0, 1]);
  await runAfter();
  is("and after it, no email", mails.length, before);
  is("a holder: the very same answer, the same nothing done before it", await atAnswer("ana@example.com", "203.0.113.7"), [303, true, 0, 0, 0, 1]);
  await runAfter();
  is("and after it, one email to it", [mails.length, mails.at(-1)?.to], [before + 1, "ana@example.com"]);
  is("the email holds a link to open, never the words", [/\/api\/store\/letters\/open\?token=[0-9a-f]{64}/.test(mails.at(-1)?.text ?? ""), (mails.at(-1)?.text ?? "").includes(SECRET)], [true, false]);
  mailDown = true;
  const downHolder = await atAnswer("ana@example.com", "203.0.113.10");
  await runAfter();
  const downStranger = await atAnswer("nobody@example.com", "203.0.113.10");
  await runAfter();
  is("with the email service down, the holder's answer and a stranger's are the same", [downHolder, downStranger], [[303, true, 0, 0, 0, 1], [303, true, 0, 0, 0, 1]]);
  mailDown = false;
  const ipKey = (ip: string) => `nl:letters:rl:ip:${createHash("sha256").update(`${ip}|${HANDLE}`).digest("hex").slice(0, 32)}`;
  is("a count of links asked always has an end", redis.keys().filter((k) => k.startsWith("nl:letters:rl:")).every((k) => Number(redis.run(["TTL", k])) > 0), true);
  redis.run(["SET", ipKey("203.0.113.11"), "1"]);
  await ask("nobody@example.com", "203.0.113.11");
  await runAfter();
  is("one left with none, by a key that ran out between two commands, is given one", Number(redis.run(["TTL", ipKey("203.0.113.11")])) > 0, true);
  is("and the count went on from it", redis.run(["GET", ipKey("203.0.113.11")]), "2");
  const token = /token=([0-9a-f]{64})/.exec(mails.at(-1)!.text)![1];
  const opened = await openRoute(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${token}`));
  const set = opened.headers.get("set-cookie") ?? "";
  is("opening it lets this browser in and goes back to the email", [opened.status, (opened.headers.get("location") ?? "").endsWith(`/@${HANDLE}/letters/${letter.id}`), set.startsWith(`${cookieName}=`)], [303, true, true]);
  const minted = /=([0-9a-f]{64})/.exec(set)![1];
  const opensKey = redis.keys().find((k) => k.startsWith("nl:letters:link:") && k.endsWith(":opens"))!;
  is("the link's count of opens has an end", Number(redis.run(["TTL", opensKey])) > 0, true);
  is("with it, the words show", (await render(store, letter.id, { [cookieName]: minted })).includes(SECRET), true);
  const formFor = async (id: string) => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("letter", id);
    form.set("email", "ana@example.com");
    return (await linkRoute(new NextRequest("https://marktmorgen.com/api/store/letters/link", { method: "POST", body: form, headers: { "x-forwarded-for": "203.0.113.9" } }))).status;
  };
  is("asking for a link to an email everyone can read is refused", await formFor(open.letter.id), 404);
  const notice = await render(store, letter.id, {}, { link: "sent" });
  is("the page says to check the inbox", notice.includes("Check your inbox"), true);

  part("Nowhere public: the list, the metadata, the code that reads copies");
  cookieValues.clear();
  const list = renderToStaticMarkup(await LettersPage({ params: Promise.resolve({ handle: `@${HANDLE}` }) }));
  is("the list shows the subject and says it is for members, never the words", [list.includes("October for members"), list.includes("For members"), list.includes(SECRET)], [true, true, false]);
  const meta = await generateMetadata({ params: Promise.resolve({ handle: `@${HANDLE}`, letter: letter.id }), searchParams: Promise.resolve({}) });
  is("the page's metadata: the subject only, kept from search engines", [JSON.stringify(meta).includes(SECRET), meta.robots && typeof meta.robots === "object" ? (meta.robots as { index?: boolean }).index : true], [false, false]);
  const openMeta = await generateMetadata({ params: Promise.resolve({ handle: `@${HANDLE}`, letter: open.letter.id }), searchParams: Promise.resolve({}) });
  is("a public email's metadata is as before", openMeta.robots, undefined);
  const root = process.cwd();
  const readers = ["app", "lib", "components"]
    .flatMap((dir) => filesUnder(join(root, dir)))
    .filter((file) => /from "@\/lib\/letters"|nl:letters:i:/.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(root.length + 1))
    .sort();
  is(
    "only these read the copies: no sitemap, feed, assistant or other page",
    readers,
    [
      "app/[handle]/letters/[letter]/page.tsx",
      "app/[handle]/letters/page.tsx",
      "app/api/store/letters/link/route.ts",
      "app/api/store/letters/route.ts",
      "app/studio/email/page.tsx",
      "lib/closed-store-data.ts",
      "lib/data-families.ts",
      "lib/letters.ts",
    ],
  );
  const viaRoute = await publishRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify({ action: "publish", id: kept.id, products: [club] }) }));
  const routeBody = (await viaRoute.json()) as Record<string, unknown>;
  const stringRoute = await publishRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify({ action: "publish", id: kept.id, products: club }) }));
  is("the route refuses products sent as a string, and the email stays kept", [stringRoute.status, (await readLetter(store, letter.id))?.products], [409, [club]]);
  const bareRoute = await publishRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify({ action: "publish", id: kept.id }) }));
  is("and published again through it without products, it stays kept", [bareRoute.status, (await readLetter(store, letter.id))?.products], [200, [club]]);
  is("the studio's route takes the products", [viaRoute.status, routeBody.ok, (await readLetter(store, letter.id))?.products], [200, true, [club]]);
  const badRoute = await publishRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${owner}` }, body: JSON.stringify({ action: "publish", id: kept.id, products: ["nope_not_a_product"] }) }));
  is("and refuses one the store does not have", badRoute.status, 409);
  is("the store lists both", (await listLetters(store)).length, 2);

  part("The creator is told when none of the products is left");
  const lone = await publishLetter(store, broadcast(store, "c1", { subject: "Knife notes" }), now, [other.product.id]);
  if (!lone.ok) throw new Error(lone.message);
  await removeProduct(OWNER, other.product.id);
  const afterRemoval = (await storeForEmail(OWNER))!;
  const loneHtml = await render(afterRemoval, lone.letter.id, { [SESSION_COOKIE]: owner });
  is("the creator reads it and is told nobody else can", [loneHtml.includes(SECRET), loneHtml.includes("None of the products you chose is on your store anymore")], [true, true]);
  is("a visitor still sees no words", (await render(afterRemoval, lone.letter.id)).includes(SECRET), false);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
