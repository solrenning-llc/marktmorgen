/**
 * Moving from ClickFunnels (lib/clickfunnels-csv.ts, lib/imports.ts,
 * lib/clickfunnels-page.ts, lib/clickfunnels-funnel.ts), run against the
 * in-memory Redis with synthetic records only. What is checked:
 *
 *   - ClickFunnels' statuses and order states read as they are written;
 *   - a contact without recorded consent comes in as a contact who cannot be
 *     emailed; an opt-out there stays an opt-out here; only Subscribed and
 *     confirmed becomes mailable; nobody unsubscribed here is put back;
 *   - the dry run says what each row becomes and writes nothing; it refuses
 *     what the import would refuse to start;
 *   - running the same files again makes nothing twice;
 *   - a saved page becomes native blocks, with every script, picture and
 *     payment field left out and said, and no markup kept;
 *   - a funnel plan writes nothing, its save makes hidden pages, a disabled
 *     funnel, a checkout box and linked offers after paying, once.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, previewImport, runImport, startImport, type PreviewResult, type PreviewRow } from "@/lib/imports";
import { leadsKey, mailable, parseContact, unsubKey, upsertContact, listCounts } from "@/lib/contacts";
import { consentFrom, readClickFunnelsStatus, readOrderStatus } from "@/lib/clickfunnels-csv";
import { convertSavedPage, trimSavedPage } from "@/lib/clickfunnels-page";
import { planFunnelImport, saveFunnelImport } from "@/lib/clickfunnels-funnel";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readProduct, readAllListings } from "@/lib/catalog";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { readForms } from "@/lib/form-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "cf-owner@example.com";

/** The writes a call makes: every command that changes something, recorded while it runs. */
const WRITES = new Set(["SET", "HSET", "HSETNX", "HDEL", "DEL", "GETDEL", "RPUSH", "LPUSH", "LTRIM", "SADD", "SREM", "SPOP", "INCR", "INCRBY", "DECR", "DECRBY", "HINCRBY", "EXPIRE", "EVAL", "ZADD", "ZREM", "PFADD"]);
async function writesOf(work: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (commands: (string | number)[][]) => {
    for (const command of commands) if (WRITES.has(String(command[0]).toUpperCase())) seen.push(`${command[0]} ${command[1]}`);
    return original(commands);
  };
  try {
    await work();
  } finally {
    redis.pipeline = original;
  }
  return seen;
}

async function run(id: string) {
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  return job;
}

async function main(): Promise<void> {
  redis.clear();

  part("ClickFunnels' words");
  is("statuses as the contacts page writes them", ["Subscribed", "Unsubscribed", "Undeliverable", "", "maybe", "yes", "no"].map(readClickFunnelsStatus), ["subscribed", "unsubscribed", "undeliverable", "none", "unknown", "subscribed", "none"]);
  is("only Subscribed and confirmed may be emailed", [consentFrom("subscribed", true), consentFrom("subscribed", false), consentFrom("none", true), consentFrom("unsubscribed", true), consentFrom("unknown", true)], ["agreed", "none", "none", "unsubscribed", "none"]);
  is("order states: an empty one in a file with a status column is not known, never paid", ["Paid", "", "Refunded", "Failed", "Canceled", "pending", "who knows"].map((s) => readOrderStatus(s)), ["paid", "unknown", "unpaid", "unpaid", "unpaid", "unpaid", "unknown"]);
  is("and read as paid only in a file with no status column", readOrderStatus("", false), "paid");

  await claimHandle(OWNER, "cfstore", "Moving Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  // Already here: Lea agreed on a page of the store; Max unsubscribed here.
  await upsertContact(listId, "lea@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(listId, "max@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await redis.pipeline([
    ["HSET", leadsKey(listId), "max@example.com", JSON.stringify({ ...parseContact((await redis.pipeline([["HGET", leadsKey(listId), "max@example.com"]]))[0])!, unsub: true, unsubAt: new Date().toISOString() })],
    ["INCR", unsubKey(listId)],
  ]);

  part("Contacts: the dry run");
  const contacts = [
    ["2", "ada@example.com", "Ada Lovelace", "Customer, VIP", "Subscribed"],
    ["3", "grace@example.com", "Grace", "", "Unsubscribed"],
    ["4", "bob@example.com", "Bob", "", ""],
    ["5", "lea@example.com", "Lea", "", "Unsubscribed"],
    ["6", "max@example.com", "Max", "", "Subscribed"],
    ["7", "ivy@example.com", "Ivy", "", "Undeliverable"],
    ["8", "ADA@example.com", "Ada again", "", "Subscribed"],
    ["9", "not-an-address", "Nobody", "", "Subscribed"],
    ["10", "kim@example.com", "Kim", "", "Pending review"],
  ];
  const input = { expected: contacts.length, file: "contacts.csv", agreed: true, consentColumn: true, tags: ["from-clickfunnels"], source: "clickfunnels" as const };
  let preview = { ok: false, reason: "kind" } as PreviewResult;
  const previewWrites = await writesOf(async () => {
    preview = await previewImport(store, "contacts", input, contacts);
  });
  if (!preview.ok) throw new Error(`no preview: ${preview.reason}`);
  const outcome = (rows: PreviewRow[]) => rows.map((r) => `${r[0]}:${r[1]}`);
  is("each row says what it becomes", outcome(preview.rows), ["2:added", "3:contact", "4:contact", "5:stopped", "6:left", "7:contact", "8:skipped", "9:error", "10:contact"]);
  is("a status it cannot read says so", preview.rows.find((r) => r[0] === 10)?.[3].includes("cannot be emailed"), true);
  is("new addresses are marked as taking room", preview.rows.filter((r) => r[6] === 1).map((r) => r[0]), [2, 3, 4, 7, 10]);
  is("the dry run writes nothing", previewWrites, []);
  const generic = await previewImport(store, "contacts", { ...input, agreed: false, source: "csv" }, contacts);
  is("a file from anywhere else still needs the creator's word to start", generic.ok ? "ok" : generic.reason, "consent");
  const members = await previewImport(store, "members", { expected: 1, file: "m.csv", source: "clickfunnels" }, [["2", "a@example.com", "x", "2026-11-03", ""]]);
  is("there is no dry run for members", members.ok ? "ok" : members.reason, "kind");
  const tooMany = await previewImport(store, "contacts", { ...input, expected: 50_001 }, contacts);
  is("nor past the import's own limit", tooMany.ok ? "ok" : tooMany.reason, "too_many");

  part("Contacts: the import");
  const started = await startImport(store, OWNER, "contacts", input);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, contacts);
  await finishUpload(store, started.job.id);
  const job = await run(started.job.id);
  is("counts as the dry run said", [job?.counts.added, job?.counts.contacts, job?.counts.stopped, job?.counts.skipped, job?.counts.errors], [1, 4, 1, 2, 1]);
  const read = async (email: string) => parseContact((await redis.pipeline([["HGET", leadsKey(listId), email]]))[0]);
  const ada = await read("ada@example.com");
  is("Ada, Subscribed and confirmed, may be emailed, with her tags", [ada && mailable(ada), ada?.tags], [true, ["Customer", "VIP", "from-clickfunnels"]]);
  const bob = await read("bob@example.com");
  is("Bob, with no status, is a contact who cannot be emailed", [bob?.agreed, bob && mailable(bob), bob?.name], [false, false, "Bob"]);
  const grace = await read("grace@example.com");
  is("Grace, Unsubscribed there, is kept as unsubscribed here", [grace?.unsub, grace?.agreed], [true, false]);
  const ivy = await read("ivy@example.com");
  is("Ivy, Undeliverable, is kept as gone", [ivy?.unsub, ivy?.gone], [true, "bounced"]);
  const lea = await read("lea@example.com");
  is("Lea, emailed until now, opted out there, so is no longer emailed", [lea?.unsub, lea && mailable(lea)], [true, false]);
  const max = await read("max@example.com");
  is("Max, who unsubscribed here, is not put back", [max?.unsub], [true]);
  is("the list counts Lea with those who left", (await listCounts(listId)).mailable, 1);

  part("Contacts: the same file again");
  const again = await startImport((await storeForEmail(OWNER))!, OWNER, "contacts", input);
  if (!again.ok) throw new Error("not started again");
  await addRows(store, again.job.id, contacts);
  await finishUpload(store, again.job.id);
  const second = await run(again.job.id);
  is("nothing new: no one added, no one stopped twice", [second?.counts.added, second?.counts.contacts, second?.counts.stopped], [0, 0, 0]);
  const later = await upsertContact(listId, "grace@example.com", { agreed: true, explicit: true, source: "free", at: new Date(Date.now() + 1000).toISOString() }, ROOM);
  is("only Grace's own check on a page of the store brings her back", later.joined, true);

  part("Contacts without the creator's word");
  const unconfirmed = await previewImport(store, "contacts", { ...input, agreed: false }, [["2", "zed@example.com", "Zed", "", "Subscribed"]]);
  is("Subscribed, but not confirmed, is a contact who cannot be emailed", unconfirmed.ok ? outcome(unconfirmed.rows) : unconfirmed.reason, ["2:contact"]);

  part("Products: dry run, import, and again");
  store = (await storeForEmail(OWNER))!;
  const products = [
    ["2", "Meal Prep Course", "$49.00", "<p>Six weeks of <b>meal prep</b>.</p>", "", ""],
    ["3", "Free Checklist", "0", "One page.", "", ""],
    ["4", "meal prep course", "49", "", "", ""],
    ["5", "", "10", "", "", ""],
  ];
  const pinput = { expected: products.length, file: "products.csv", source: "clickfunnels" as const };
  const pview = await previewImport(store, "products", pinput, products);
  is("the dry run of products", pview.ok ? outcome(pview.rows) : pview.reason, ["2:added", "3:added", "4:skipped", "5:error"]);
  const pstart = await startImport(store, OWNER, "products", pinput);
  if (!pstart.ok) throw new Error("products not started");
  await addRows(store, pstart.job.id, products);
  await finishUpload(store, pstart.job.id);
  const pjob = await run(pstart.job.id);
  is("two drafts made", pjob?.counts.added, 2);
  store = (await storeForEmail(OWNER))!;
  const count = store.catalog.items.length;
  const pview2 = await previewImport(store, "products", pinput, products);
  is("the dry run now finds them in the store", pview2.ok ? outcome(pview2.rows) : pview2.reason, ["2:already", "3:already", "4:skipped", "5:error"]);
  const pagain = await startImport(store, OWNER, "products", pinput);
  if (!pagain.ok) throw new Error("products not started again");
  await addRows(store, pagain.job.id, products);
  await finishUpload(store, pagain.job.id);
  const pjob2 = await run(pagain.job.id);
  is("and the same file again makes no copies", [pjob2?.counts.added, pjob2?.counts.already, (await storeForEmail(OWNER))!.catalog.items.length], [0, 2, count]);

  part("Past buyers from an Orders export");
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no guide");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  store = (await storeForEmail(OWNER))!;
  const orders = [
    ["2", "ada@example.com", "The Guide", "Paid"],
    ["3", "bob@example.com", "The Guide", "Refunded"],
    ["4", "cy@example.com", "The Guide", "on hold maybe"],
    ["5", "dee@example.com", "The Guide"],
  ];
  const oview = await previewImport(store, "purchases", { expected: orders.length, file: "orders.csv", source: "clickfunnels" }, orders);
  is("only paid orders give anything; a row without a status in a file with a status column gives nothing", oview.ok ? outcome(oview.rows) : oview.reason, ["2:added", "3:skipped", "4:error", "5:error"]);

  part("A saved page into blocks");
  const saved = `<!doctype html><html><head><title>Meal Prep | Moving Kitchen</title><script src="https://connect.facebook.net/fbevents.js"></script><script>window.cfData={"secret":"x"}</script><style>body{}</style></head><body>
  <nav><a href="/">Home</a></nav>
  <div class="elHeadlineWrapper"><h1>Cook once, eat all week</h1></div><div class="hide-desktop"><h1>Cook once, eat all week</h1></div>
  <p>A six-week course &amp; a community.</p>
  <img src="https://images.clickfunnels.com/a/photo.jpg" alt="Food on a table">
  <h2>What you get</h2><ul><li>Weekly plans</li><li>Shopping lists</li></ul>
  <p onclick="steal()">Join <a href="https://example.com">here</a> <script>alert(1)</script>today.</p>
  <iframe src="https://player.vimeo.com/video/123456789"></iframe>
  <div class="countdown-timer">00:10:00</div>
  <form><input type="hidden" name="funnel" value="1"><input type="email" name="email" placeholder="Email address"><input name="card_number" placeholder="Card number">
  <label><input type="checkbox"> I agree to the terms</label><label><input type="checkbox"> Yes, add the recipe book for $7</label><button type="submit">Buy now</button></form>
  <a class="elButton" href="https://pay.example.com"><span>Start today</span><span>Instant access</span></a>
  <h2>${"Long ".repeat(40)}heading</h2><p>${"word ".repeat(900)}</p>
  <footer>Copyright</footer></body></html>`;
  const draft = convertSavedPage(trimSavedPage(saved), "meal-prep.html");
  is("the title and the blocks, in order", [draft.title, draft.blocks.map((b) => b.kind)], ["Meal Prep | Moving Kitchen", ["hero", "text", "video", "form", "cta", "text", "text"]]);
  is("the hero's headline and the line under it", draft.blocks[0].kind === "hero" ? [draft.blocks[0].headline, draft.blocks[0].sub] : null, ["Cook once, eat all week", "A six-week course & a community."]);
  is("a list under its heading, a link's words kept", draft.blocks[1].kind === "text" ? draft.blocks[1].body : null, "- Weekly plans\n- Shopping lists\n\nJoin here today.");
  is("a button's main and small line", draft.blocks[4].kind === "cta" ? [draft.blocks[4].label, draft.blocks[4].note] : null, ["Start today", "Instant access"]);
  is("the form asks the email, and the payment field is never carried", [draft.form?.fields, draft.form?.button, draft.checkout], [[{ type: "email", label: "Email address", required: true }], "Buy now", true]);
  is("the order bump's words are found, the consent box is not one", draft.bumps, [{ pitch: "Yes, add the recipe book for $7" }]);
  const dropped = Object.fromEntries(draft.dropped.map((d) => [d.what, d.count]));
  is("everything left out is said", [dropped.scripts, dropped.tracking, dropped.pictures, dropped.payment, dropped.consent, dropped.countdown, dropped.menus, dropped.repeats, dropped.links], [2, 1, 1, 1, 1, 1, 2, 1, 1]);
  const all = JSON.stringify(draft.blocks);
  is("no markup, script or handler survives", [/[<>]/.test(all), all.includes("alert"), all.includes("steal"), all.includes("secret")], [false, false, false, false]);
  const longText = draft.blocks.slice(5).map((b) => (b.kind === "text" ? b.body : "")).join(" ");
  is("a heading too long to be one is kept as words, and a long text is split, not cut", [longText.startsWith("Long Long"), longText.split("word").length - 1], [true, 900]);
  is("the page as an offer after paying", draft.offer, { headline: "Cook once, eat all week", text: "A six-week course & a community." });

  part("A funnel: the dry run");
  const main = await addProduct(OWNER, "Meal Prep Pro", "", "49", null);
  const bump = await addProduct(OWNER, "Recipe Book", "", "7", null);
  const up = await addProduct(OWNER, "Coaching Pack", "", "99", null);
  const downsell = await addProduct(OWNER, "Coaching Lite", "", "39", null);
  if (!main.ok || !bump.ok || !up.ok || !downsell.ok) throw new Error("no products");
  for (const p of [main, bump, up, downsell]) await setProductLink(OWNER, p.product.id, `https://example.com/${p.product.id}`);
  store = (await storeForEmail(OWNER))!;
  const optin = convertSavedPage(trimSavedPage(`<html><head><title>Free plan</title></head><body><h1>Get the free plan</h1><p>Seven days.</p><form><input name="first_name" placeholder="First name"><input type="email" placeholder="Email"><button>Send it</button></form></body></html>`), "optin.html");
  const oto = convertSavedPage(trimSavedPage(`<html><body><h1>Wait! Add coaching</h1><p>Four calls with me.</p><a class="btn">Yes</a></body></html>`), "oto.html");
  const lite = convertSavedPage(trimSavedPage(`<html><body><h1>How about two calls?</h1><p>Half the calls.</p></body></html>`), "lite.html");
  const thanks = convertSavedPage(trimSavedPage(`<html><body><h1>You're in</h1><p>Check your email.</p></body></html>`), "thanks.html");
  const pages = [
    { file: "optin.html", role: "page", product: "", bumps: [], draft: optin },
    { file: "order.html", role: "checkout", product: main.product.id, bumps: [bump.product.id], draft },
    { file: "oto.html", role: "upsell", product: up.product.id, bumps: [], draft: oto },
    { file: "lite.html", role: "downsell", product: downsell.product.id, bumps: [], draft: lite },
    { file: "thanks.html", role: "page", product: "", bumps: [], draft: thanks },
  ];
  const funnelInput = { name: "Meal prep launch", pages };
  let plan = { actions: [], issues: [], key: "", done: null } as Awaited<ReturnType<typeof planFunnelImport>>;
  const planWrites = await writesOf(async () => {
    plan = await planFunnelImport(store, funnelInput);
  });
  is("no errors", plan.issues.filter((i) => i.level === "error"), []);
  is("what will be made", plan.actions.map((a) => a.kind), ["page", "page", "bump", "offer", "offer", "step", "step", "step", "funnel"]);
  const offers = plan.actions.filter((a) => a.kind === "offer") as { yes: string; no: string; price: string }[];
  is("the upsell's no leads to the downsell, both end after", offers.map((o) => [o.price, o.yes, o.no]), [["$99", "the end", "offer 2"], ["$39", "the end", "the end"]]);
  is("the plan writes nothing", planWrites, []);
  const wrong = await planFunnelImport(store, { name: "x", pages: [{ ...pages[3] }, { ...pages[2] }, { ...pages[1] }, { ...pages[3], product: bump.product.id }] });
  is(
    "an offer with no checkout before it, and a downsell with no upsell before it, are refused",
    wrong.issues.filter((i) => i.level === "error").map((i) => i.file),
    ["lite.html", "oto.html", "lite.html"],
  );
  const forged = await planFunnelImport(store, { name: "x", pages: [{ ...pages[0], draft: { ...optin, blocks: [{ id: "abcd", kind: "hero", headline: "x", sub: "", media: "none", video: null }, { id: "abcd", kind: "text", heading: "", body: "y" }] } }] });
  is("a draft the page editor would refuse is refused", forged.issues.some((i) => i.level === "error" && i.text.includes("could not be read")), true);

  part("A funnel: the import, and again");
  const result = await saveFunnelImport(store, funnelInput);
  if (!result.ok) throw new Error(`not saved: ${result.reason} ${JSON.stringify(result.plan?.issues)}`);
  store = (await storeForEmail(OWNER))!;
  is("two pages made, out of the menu and kept back", store.sitePages.map((p) => [p.title, p.nav, p.from]), [["Free plan", false, -1], ["You're in", false, -1]]);
  const optinPage = await readPage(store.statsId, siteKey(store.sitePages[0].id));
  const forms = await readForms(store.statsId);
  is("its blocks, hidden, and its form made under Forms", [optinPage.hidden, optinPage.blocks.map((b) => b.kind), forms.length, forms[0]?.fields.map((f) => f.type)], [true, ["hero", "form"], 1, ["short", "email"]]);
  is("the form block points at it", optinPage.blocks[1].kind === "form" ? optinPage.blocks[1].form === forms[0].id : false, true);
  const funnels = await readPageFunnels(store.statsId);
  is("one funnel, switched off, page then checkout then page", [funnels.length, funnels[0]?.on, funnels[0]?.steps.map((s) => s.kind)], [1, false, ["page", "product", "page"]]);
  const owner = await readProduct(store, main.product.id);
  is("the order bump is a box at the checkout, at the product's own price", owner?.bumps, [{ productId: bump.product.id, priceCents: 700, pitch: "Yes, add the recipe book for $7" }]);
  is("the offers after paying, linked", owner?.funnel?.steps.map((s) => [s.productId, s.priceCents, s.yes, s.no]), [[up.product.id, 9900, null, "cfo1"], [downsell.product.id, 3900, null, null]]);
  const twice = await saveFunnelImport(store, funnelInput);
  is("the same import again answers with what the first made", twice.ok ? [twice.again, twice.saved.funnel.id] : twice.reason, [true, funnels[0].id]);
  store = (await storeForEmail(OWNER))!;
  is("and makes nothing twice", [store.sitePages.length, (await readPageFunnels(store.statsId)).length, (await readProduct(store, main.product.id))?.bumps.length, (await readForms(store.statsId)).length], [2, 1, 1, 1]);
  const renamed = await planFunnelImport(store, { ...funnelInput, name: "Meal prep launch 2" });
  is("a second run under another name uses the pages already made", renamed.actions.filter((a) => a.kind === "page").map((a) => (a as { again: boolean }).again), [true, true]);
  is("and leaves the box and the offers already there", renamed.issues.filter((i) => i.level === "warning" && /already/.test(i.text)).length >= 2, true);
  is("products are as they were", (await readAllListings(store)).length, store.catalog.items.length);
  const doubled = await planFunnelImport(store, { name: "x", pages: [pages[0], pages[0]] });
  is("the same page chosen twice is refused", doubled.issues.some((i) => i.level === "error" && i.text.includes("chosen twice")), true);

  part("A run that stopped after making its funnel");
  const partialInput = { name: "Thanks only", pages: [pages[4]] };
  const partialPlan = await planFunnelImport(store, partialInput);
  const madeFunnel = (await readPageFunnels(store.statsId))[0];
  await redis.pipeline([["HSET", `nl:imports:cf:${store.sid}`, `run:${partialPlan.key}`, JSON.stringify({ state: "funnel", funnel: madeFunnel.id, at: Date.now() })]]);
  const resumedPlan = await planFunnelImport(store, partialInput);
  is("the plan says it finishes the earlier run", [resumedPlan.partial, resumedPlan.issues.some((i) => i.text.includes("stopped partway"))], [madeFunnel.id, true]);
  const resumed = await saveFunnelImport(store, partialInput);
  is("and uses the funnel it made instead of a second one", resumed.ok ? [resumed.saved.funnel.id, (await readPageFunnels(store.statsId)).length] : resumed.reason, [madeFunnel.id, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
