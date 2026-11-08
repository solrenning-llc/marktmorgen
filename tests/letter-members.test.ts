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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, removeProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Broadcast } from "@/lib/broadcasts";
import { MAX_LETTER_PRODUCTS, membersOnly, parseLetter } from "@/lib/letter-rules";
import { letterIdFor, listLetters, publishLetter, publishedLetters, readLetter } from "@/lib/letters";
import { letterReader } from "@/lib/letter-access";
import { holdsProducts, holdsProductsOrThrow, paidForAny } from "@/lib/community-access";
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import { mintPass, passCookieName } from "@/lib/learn";
import LetterPage, { generateMetadata } from "@/app/[handle]/letters/[letter]/page";
import LettersPage from "@/app/[handle]/letters/page";
import { POST as publishRoute } from "@/app/api/store/letters/route";
import { POST as linkRoute } from "@/app/api/store/letters/link/route";
import { GET as openRoute } from "@/app/api/store/letters/open/route";
import { PublishControl } from "@/components/letter-publish-control";
import { LinkRequestForm } from "@/components/link-request-form";
import { cookieValues } from "./letter-members-world";
import { afterTasks } from "./next-server-after-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_letter_members_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only"; // one of the synthetic credentials the Resend fallback fixture knows (tests/resend-fixture-credentials.ts)

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
/** Whether the creator's Stripe account cannot be asked (it answers 500). */
let stripeDown = false;
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
  if (stripeDown) return answer({ error: { message: "down" } }, 500);
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

/**
 * EXPIRE with an option (NX, XX, GT, LT) is refused here, as a Redis or REST
 * service that does not take it would: the code keeps to SET NX EX and INCR,
 * the pattern every counter already uses.
 */
let expireOptions = 0;
const realPipeline = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof realPipeline }).pipeline = (commands) => {
  if (commands.some((c) => String(c[0]).toUpperCase() === "EXPIRE" && c.length > 3)) {
    expireOptions += 1;
    return Promise.reject(new Error("ERR syntax error"));
  }
  return realPipeline(commands);
};

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
  // Twenty-one more, all distinct, for the cap.
  const many: string[] = [];
  for (let i = 0; i < MAX_LETTER_PRODUCTS + 1; i += 1) {
    const one = await addProduct(OWNER, `Workbook ${i + 1}`, "", "9", null);
    if (!one.ok) throw new Error("no workbook");
    many.push(one.product.id);
  }
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();

  part("The creator chooses the products when publishing");
  const kept = broadcast(store, "a1");
  const refused = await publishLetter(store, kept, now, ["nope_not_a_product"]);
  is("a product this store does not have is refused", [refused.ok, refused.ok ? "" : refused.reason], [false, "products"]);
  const tooMany = await publishLetter(store, kept, now, many);
  is(`${MAX_LETTER_PRODUCTS + 1} distinct products of the store are refused`, [new Set(many).size, tooMany.ok, tooMany.ok ? "" : tooMany.reason], [MAX_LETTER_PRODUCTS + 1, false, "products"]);
  const enough = await publishLetter(store, broadcast(store, "d1", { subject: "Workbook notes" }), now, many.slice(0, MAX_LETTER_PRODUCTS));
  is(`${MAX_LETTER_PRODUCTS} are taken`, enough.ok ? enough.letter.products?.length : 0, MAX_LETTER_PRODUCTS);
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
  const emptied = await publishLetter(store, kept, now + 3, []);
  is("an empty choice over an email kept for members is refused, and it stays kept", [emptied.ok, emptied.ok ? "" : emptied.reason, (await readLetter(store, letter.id))?.products], [false, "kept", [club]]);
  const toAll = await publishLetter(store, kept, now + 3, [], true);
  is("only an empty choice said on purpose (open) opens it to everyone", [toAll.ok, toAll.ok ? membersOnly(toAll.letter) : true], [true, false]);
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

  part("The studio sees which are kept, and a failed read is not \"not published\"");
  const seen = await publishedLetters(store);
  is("one read says it is published and kept for members", seen?.get(letter.id), { members: true });
  is("and a public one is published for everyone", (await publishLetter(store, broadcast(store, "e1", { subject: "Public notes" }), now)).ok && (await publishedLetters(store))?.get(letterIdFor(store.sid, "e1".padStart(24, "0")))?.members, false);
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: unknown }).pipeline = async () => {
    throw new Error("the database is down");
  };
  const failed = await publishedLetters(store);
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = pipeline;
  is("a failed read is unknown, not an empty list", failed, null);
  const control = (props: { path: string | null; members: boolean; unknown: boolean }) =>
    renderToStaticMarkup(createElement(PublishControl, { id: "x", disabled: false, onDone: () => {}, products: [{ id: club, title: "Butter Club" }], ...props }));
  is("the studio says \"For members only\" beside \"Published on your store\"", [control({ path: "/@x/letters/y", members: true, unknown: false }).includes("For members only"), control({ path: "/@x/letters/y", members: false, unknown: false }).includes("For members only")], [true, false]);
  const unknownHtml = control({ path: null, members: false, unknown: true });
  is("and, when it could not read, says so and offers no Publish", [unknownHtml.includes("Could not check whether it is on your store"), unknownHtml.includes("Publish on your store")], [true, false]);

  part("A refund in full closes it");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club, 4900)];
  is("kept answer: still open for its few minutes", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "in");
  forgetAnswers();
  is("asked again: closed", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "closed");
  is("and the page no longer shows the words", (await render(store, letter.id, { [cookieName]: anaPass })).includes(SECRET), false);
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", club)];
  forgetAnswers();

  part("A dispute lost, and a membership that stopped, close it too");
  const cyPass = await pass("cy@example.com", "all");
  const lost = paid("cs_test_cy0000000001", club);
  sessions["cy@example.com"] = [lost];
  is("paid and undisputed: open", (await letterReader(store, letter, jar({ [cookieName]: cyPass }))).state, "in");
  sessions["cy@example.com"] = [{ ...lost, payment_intent: { id: "pi_cy01", latest_charge: { ...charge(4900, 0), id: "ch_TestCyLost01", disputed: true, dispute: { status: "lost" } } } }];
  forgetAnswers();
  is("the dispute lost: closed", (await letterReader(store, letter, jar({ [cookieName]: cyPass }))).state, "closed");
  const deePass = await pass("dee@example.com", "all");
  const member = (status: string) => ({ ...paid("cs_test_dee000000001", club), mode: "subscription", payment_intent: null, subscription: { id: "sub_TestDee0001", status } });
  sessions["dee@example.com"] = [member("active")];
  forgetAnswers();
  is("a membership running: open", (await letterReader(store, letter, jar({ [cookieName]: deePass }))).state, "in");
  sessions["dee@example.com"] = [member("canceled")];
  forgetAnswers();
  is("the membership stopped: closed", (await letterReader(store, letter, jar({ [cookieName]: deePass }))).state, "closed");
  forgetAnswers();

  part("Stripe that cannot be asked is unknown, never \"none of these products\"");
  stripeDown = true;
  is("a holder whose answer ran out, with Stripe down: unknown", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "unknown");
  const downHtml = await render(store, letter.id, { [cookieName]: anaPass });
  is(
    "the page says it could not check, offers to check again, never says none, never shows the form or the words",
    [downHtml.includes("We couldn&#x27;t check your purchase just now"), downHtml.includes(`href="/@${HANDLE}/letters/${letter.id}"`), downHtml.includes("This address has none of these products"), downHtml.includes("/api/store/letters/link"), downHtml.includes(SECRET)],
    [true, true, false, false, false],
  );
  is("nothing is kept from the failed ask", redis.keys().filter((k) => k.startsWith("nl:letters:ok:")).length, 0);
  stripeDown = false;
  is("Stripe back: the holder reads it again", [(await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, (await render(store, letter.id, { [cookieName]: anaPass })).includes(SECRET)], ["in", true]);
  forgetAnswers();

  part("Codex G: HTTP 200 that is incomplete is unknown, not a closed door");
  const savedFetch = globalThis.fetch;
  for (const [label, payload] of [
    ["missing data", {}],
    ["null data", { object: "list", data: null, has_more: false }],
    ["unscanned next page", { object: "list", data: Array.from({length:100}, (_,i)=>paid(`cs_test_other${String(i).padStart(12,"0")}`, other.product.id)), has_more: true }],
  ] as const) {
    forgetAnswers();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      return url.hostname === "api.stripe.com" && url.pathname.endsWith("/checkout/sessions")
        ? new Response(JSON.stringify(payload), {status:200}) : savedFetch(input,init);
    }) as typeof fetch;
    try {
      const result = await letterReader(store, letter, jar({[cookieName]:anaPass}));
      is(`${label}: ownership unknown, not closed`, result.state, "unknown");
      is(`${label}: no negative cache invented`, redis.keys().filter(k=>k.startsWith("nl:letters:ok:")).length, 0);
      const html = await render(store,letter.id,{[cookieName]:anaPass});
      is(`${label}: real page says unknown and never shows body/false denial`,
        [html.includes("We couldn&#x27;t check your purchase just now"),html.includes("This address has none of these products"),html.includes(SECRET)], [true,false,false]);
    } finally {globalThis.fetch=savedFetch;}
    forgetAnswers();
    is(`${label}: valid provider control reopens holder`, (await letterReader(store,letter,jar({[cookieName]:anaPass}))).state,"in");
  }
  forgetAnswers();

  part("Codex G return: exact wire rows and bounded reads");
  for (const [label, payload, endpoint] of [
    ["session id only", {data:[{id:"cs_test_unknown001"}],has_more:false}, "/checkout/sessions"],
    ["session missing status", {data:[{...paid("cs_test_unknown002",club),status:undefined}],has_more:false}, "/checkout/sessions"],
    ["session missing payment", {data:[{...paid("cs_test_unknown003",club),payment_status:undefined}],has_more:false}, "/checkout/sessions"],
    ["intent id only", {data:[{id:"pi_TestUnknown001"}],has_more:false}, "/payment_intents"],
    ["intent missing status", {data:[{id:"pi_TestUnknown002",metadata:{kind:"upsell",store:HANDLE,product:club}}],has_more:false}, "/payment_intents"],
    ["empty row", {data:[{}],has_more:false}, "/checkout/sessions"],
    ["array row", {data:[[]],has_more:false}, "/checkout/sessions"],
    ["missing has_more", {data:[]}, "/checkout/sessions"],
    ["string has_more", {data:[],has_more:"false"}, "/checkout/sessions"],
    ["null entry", {data:[null],has_more:false}, "/checkout/sessions"],
    ["primitive entry", {data:[0],has_more:false}, "/checkout/sessions"],
    ["unknown session status", {data:[{...paid("cs_test_badstatus001",club),status:"alien",payment_status:"alien"}],has_more:false}, "/checkout/sessions"],
    ["intent empty row", {data:[{}],has_more:false}, "/payment_intents"],
    ["intent array row", {data:[[]],has_more:false}, "/payment_intents"],
    ["intent missing pagination", {data:[]}, "/payment_intents"],
    ["intent more pages", {data:[],has_more:true}, "/payment_intents"],
  ] as const) {
    forgetAnswers();
    const answer=globalThis.fetch;
    globalThis.fetch=(async(input: string | URL | Request, init?:RequestInit)=>{
      const url=new URL(String(input instanceof Request?input.url:input));
      if(url.hostname!=="api.stripe.com")return answer(input,init);
      if(url.pathname.endsWith(endpoint)) return new Response(JSON.stringify(payload),{status:200});
      if(endpoint==="/payment_intents" && url.pathname.endsWith("/checkout/sessions")) return new Response(JSON.stringify({data:[paid("cs_test_otherCust01",other.product.id)],has_more:false}));
      return answer(input,init);
    }) as typeof fetch;
    try {
      is(`${label}: reader unknown`,(await letterReader(store,letter,jar({[cookieName]:anaPass}))).state,"unknown");
      is(`${label}: negative cache absent`,redis.keys().filter(k=>k.startsWith("nl:letters:ok:")).length,0);
      const html=await render(store,letter.id,{[cookieName]:anaPass});
      is(`${label}: no false denial or body`,[html.includes("We couldn&#x27;t check your purchase just now"),html.includes("This address has none of these products"),html.includes(SECRET)],[true,false,false]);
      const key=`nl:g2464:${label}`;
      is(`${label}: nonstrict refuses`,await holdsProducts(store,[club],"ana@example.com",key,"g"),false);
      is(`${label}: nonstrict cache absent`,redis.run(["GET",key]),null);
      let thrown=false;
      try { await holdsProductsOrThrow(store,[club],"ana@example.com",key+":strict","g"); } catch {thrown=true;}
      is(`${label}: strict throws`,thrown,true);
    } finally {globalThis.fetch=answer;forgetAnswers();}
  }
  for(const count of [10,11]) {
    const answer=globalThis.fetch;
    let piCalls=0;
    globalThis.fetch=(async(input:string | URL | Request)=>{
      const url=new URL(String(input instanceof Request?input.url:input));
      if(url.pathname.endsWith("/checkout/sessions")) return new Response(JSON.stringify({data:Array.from({length:count},(_,i)=>({...paid(`cs_test_bound${i}`,other.product.id),customer:`cus_TestBoundary${i}`})),has_more:false}));
      piCalls+=1;
      return new Response(JSON.stringify({data:[],has_more:false}));
    }) as typeof fetch;
    try {
      let result:unknown;
      try { result=await paidForAny(store,"ana@example.com",new Set([club])); } catch {result="unknown";}
      is(`${count} customers: result`,result,count===10?false:"unknown");
      is(`${count} customers: at most ten payment queries`,piCalls,10);
    } finally {globalThis.fetch=answer;}
  }
  part("The link form: its field is named and described, and a notice after it is reached");
  const formHtml = await render(store, letter.id);
  is(
    "the field is labeled as an email address and described by the line that explains it",
    [/<label[^>]*for="letter-email"[^>]*>Your email address<\/label>/.test(formHtml), /<p[^>]*id="letter-email-explain"[^>]*>Type the address you used/.test(formHtml), /<input[^>]*aria-describedby="letter-email-explain"/.test(formHtml)],
    [true, true, true],
  );
  is("the form is named by its question", /<form[^>]*aria-labelledby="letter-email-title"/.test(formHtml) && /id="letter-email-title"[^>]*>Already have one\? Read it here</.test(formHtml), true);
  for (const state of ["email", "limited", "error", "sent"]) {
    const arrived = await render(store, letter.id, {}, { link: state });
    is(`after the form (?link=${state}), the notice can take the focus the page gives it`, /<div[^>]*tabindex="-1"[^>]*data-arrival="focus"[^>]*role="status"/.test(arrived) || /<div[^>]*data-arrival="focus"[^>]*tabindex="-1"/.test(arrived) || /<div[^>]*role="status"[^>]*tabindex="-1"[^>]*data-arrival/.test(arrived), true);
  }
  for (const odd of ["constructor", "toString", "__proto__", "hasOwnProperty", "nope"]) {
    is(`?link=${odd} draws no notice`, (await render(store, letter.id, {}, { link: odd })).includes('role="status"'), false);
  }
  const shared = renderToStaticMarkup(createElement(LinkRequestForm, { action: "/api/store/community/link", hidden: { handle: HANDLE }, id: "community-email", label: "Already a member?", explain: "Type the address you used to buy or sign up.", button: "Send me the link", placeholder: "you@example.com", language: "es" }));
  is(
    "the community's form, the same component: named, described, labeled in the store's language",
    [/aria-labelledby="community-email-title"/.test(shared), /aria-describedby="community-email-explain"/.test(shared), /<label[^>]*for="community-email"[^>]*>Tu dirección de email<\/label>/.test(shared)],
    [true, true, true],
  );

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
  await ask("nobody@example.com", "203.0.113.12");
  await runAfter();
  const firstTtl = Number(redis.run(["TTL", ipKey("203.0.113.12")]));
  advance(10 * 60_000);
  await ask("nobody@example.com", "203.0.113.12");
  await runAfter();
  const laterTtl = Number(redis.run(["TTL", ipKey("203.0.113.12")]));
  is("the window does not slide: ten minutes on, it ends when it would have", [firstTtl, laterTtl <= firstTtl - 600 && laterTtl > 0], [3600, true]);
  const token = /token=([0-9a-f]{64})/.exec(mails.at(-1)!.text)![1];
  const keysBefore = redis.keys().length;
  const stranger = await openRoute(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${"f".repeat(64)}`, { headers: { "accept-language": "es-MX,es;q=0.9" } }));
  is("a token that is no link: gone, in the browser's language, and nothing written", [stranger.status, (await stranger.text()).startsWith("Este enlace caducó"), redis.keys().length], [410, true, keysBefore]);
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

  part("The limits on the form and on the link");
  for (let i = 1; i <= 10; i += 1) await ask(`ip-limit-${i}@example.com`, "198.51.100.50");
  await runAfter();
  is("the 11th request from one address on the internet: too many", (await ask("ip-limit-11@example.com", "198.51.100.50")).location.endsWith("?link=limited"), true);
  const perAddress: string[] = [];
  for (let i = 1; i <= 6; i += 1) perAddress.push((await ask("zed@example.com", `198.51.100.${60 + i}`)).location.replace(/^.*\?link=/, ""));
  await runAfter();
  is("the 6th request for one email address, from anywhere: too many", perAddress, ["sent", "sent", "sent", "sent", "sent", "limited"]);
  is("and the page says so", (await render(store, letter.id, {}, { link: "limited" })).includes("Too many requests"), true);
  const mailsBeforeOpens = mails.length;
  await ask("ana@example.com", "198.51.100.80");
  await runAfter();
  is("a fresh link for the holder", mails.length, mailsBeforeOpens + 1);
  const fresh = /token=([0-9a-f]{64})/.exec(mails.at(-1)!.text)![1];
  const opens: number[] = [];
  for (let i = 1; i <= 11; i += 1) opens.push((await openRoute(new NextRequest(`https://marktmorgen.com/api/store/letters/open?token=${fresh}`))).status);
  is("a link opens 10 times; the 11th is gone", opens, [...Array(10).fill(303), 410]);

  part("The email service known to be down: said honestly, the same for everyone");
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  afterTasks.length = 0;
  const holderNoMail = await ask("ana@example.com", "198.51.100.90");
  const strangerNoMail = await ask("nobody-else@example.com", "198.51.100.90");
  const leftAfter = afterTasks.length;
  process.env.RESEND_API_KEY = key;
  is(
    "no \"on its way\": both told the email could not be sent, and nothing is left to do after the answer",
    [holderNoMail.location.replace(/^.*\?link=/, ""), strangerNoMail.location.replace(/^.*\?link=/, ""), leftAfter],
    ["error", "error", 0],
  );
  is("the page says the email could not be sent", (await render(store, letter.id, {}, { link: "error" })).includes("The email could not be sent"), true);

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
  is("no EXPIRE with an option was ever sent", expireOptions, 0);
  is("the store lists all four", (await listLetters(store))?.length, 4);

  part("The feature page says what is true of an email kept for members");
  // lib/help-content.ts says the same and waits: it is reserved by another agent (Claude 2, 513 [PF1]).
  for (const file of ["lib/feature-pages.ts"]) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    is(`${file}: "anyone can read it" always comes with its exception`, [/anyone can read it once it is(?: published, including people who are not on your list)?\. /.test(text), text.includes("unless you keep it for the people who have products you choose")], [false, true]);
  }

  part("A product still for sale whose listing does not read is not \"no longer for sale\"");
  // More products than the first page holds, so one listing is read from its own record, not the store's head.
  const extra: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const one = await addProduct(OWNER, `Extra ${i + 1}`, "", "9", null);
    if (!one.ok) throw new Error("no extra product");
    extra.push(one.product.id);
  }
  const current = (await storeForEmail(OWNER))!;
  const unlisted = [...many, ...extra].find((id) => !current.catalog.head.some((l) => l.id === id));
  if (!unlisted || current.catalog.inline || !current.catalog.id) throw new Error("no product outside the head to make unreadable");
  const kept2 = await publishLetter(current, broadcast(current, "f1", { subject: "Workbook members" }), now, [unlisted]);
  if (!kept2.ok) throw new Error(kept2.message);
  const listingKey = `nl:catalog:${current.catalog.id}:l:${unlisted}`;
  const listing = redis.run(["GET", listingKey]);
  if (typeof listing !== "string") throw new Error("no listing record");
  redis.run(["SET", listingKey, "{not json"]);
  const unreadableHtml = await render(store, kept2.letter.id);
  is(
    "a visitor: never told it is gone; told the products could not all be shown, without \"below\", and still offered the form",
    [unreadableHtml.includes("no longer for sale"), unreadableHtml.includes("products below"), unreadableHtml.includes("We couldn&#x27;t show every one of them just now"), unreadableHtml.includes("/api/store/letters/link"), unreadableHtml.includes(SECRET)],
    [false, false, true, true, false],
  );
  const fayPass = await pass("fay@example.com", "all");
  sessions["fay@example.com"] = [paid("cs_test_fay000000001", unlisted)];
  is("and a proved holder of it reads it", (await render(store, kept2.letter.id, { [cookieName]: fayPass })).includes(SECRET), true);
  const ownerUnreadable = await render(store, kept2.letter.id, { [SESSION_COOKIE]: owner });
  is("the creator is not told none of the products is left", [ownerUnreadable.includes("None of the products you chose is on your store anymore"), ownerUnreadable.includes("Only you and people who have one of these products")], [false, true]);
  redis.run(["SET", listingKey, listing]);
  is("read again, the list is whole and says \"below\"", (await render(store, kept2.letter.id)).includes("products below"), true);

  part("The creator is told when none of the products is left");
  const lone = await publishLetter(store, broadcast(store, "c1", { subject: "Knife notes" }), now, [other.product.id]);
  if (!lone.ok) throw new Error(lone.message);
  await removeProduct(OWNER, other.product.id);
  const afterRemoval = (await storeForEmail(OWNER))!;
  const loneHtml = await render(afterRemoval, lone.letter.id, { [SESSION_COOKIE]: owner });
  is("the creator reads it and is told nobody else can", [loneHtml.includes(SECRET), loneHtml.includes("None of the products you chose is on your store anymore")], [true, true]);
  is("a visitor still sees no words", (await render(afterRemoval, lone.letter.id)).includes(SECRET), false);
  for (const [who, cookie] of [["a visitor", {}], ["a proved address", { [cookieName]: anaPass }]] as [string, Record<string, string>][]) {
    const gone = await render(afterRemoval, lone.letter.id, cookie);
    is(
      `${who} is told its products are no longer for sale, with no empty list, no "below" and no form`,
      [gone.includes("The products this email was for are no longer for sale"), gone.includes("<ul"), gone.includes("products below"), gone.includes("/api/store/letters/link"), gone.includes("This address has none of these products")],
      [true, false, false, false, false],
    );
  }

  part("Revisor 1 on #2464: one unreadable entry does not take away a purchase another entry proves; reads pin Stripe's version");
  {
    forgetAnswers();
    const answer = globalThis.fetch;
    const versions: (string | null)[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname !== "api.stripe.com") return answer(input, init);
      if (url.pathname.endsWith("/checkout/sessions") || url.pathname.endsWith("/payment_intents")) versions.push(new Headers(init?.headers).get("Stripe-Version"));
      if (url.pathname.endsWith("/checkout/sessions")) return new Response(JSON.stringify({ object: "list", data: [{ ...paid("cs_test_oddstate0001", club), status: "a_state_stripe_adds_later" }, paid("cs_test_goodstate001", club)], has_more: false }), { status: 200 });
      return answer(input, init);
    }) as typeof fetch;
    try {
      is("a paid session beside an entry in a state not known here: the holder is let in", (await letterReader(store, letter, jar({ [cookieName]: anaPass }))).state, "in");
      is("every list read pins Stripe's version", versions.length > 0 && versions.every((v) => v === STRIPE_VERSION), true);
    } finally {
      globalThis.fetch = answer;
      forgetAnswers();
    }
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
