/**
 * "Send me a link" for a community, a private podcast and the buyers'
 * library must not tell a stranger whether an address holds what it asks
 * about. With the mail route ready but the final send failing (SES refuses
 * the message, no Resend key, or something throws after the entitlement
 * check), the holder used to get "error" while an address that holds
 * nothing got "sent", and the short-lived link written for the failed email
 * of a community or a library stayed in Redis for its hour or its day.
 * The answer's time told them apart too: the holder's waited on the email,
 * the stranger's did not. Now the answer comes right after the limits, and
 * the entitlement, the link and the email run after it (next/server
 * `after`, held here by tests/next-server-after-world.ts and run by drain()).
 * The same defect as the course link (lib/learn.ts, claude5/course-link-uniform).
 *
 * Actual functions under test: requestCommunityLink, sendFeedLink,
 * requestLibraryLink and their public routes, with MemoryRedis and the
 * synthetic SES fixture (provider HTTP replies only, never the send result).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setPastBuyers,
  setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeForEmail,
} from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { grantImported } from "@/lib/imported-purchases";
import { freshConfig, saveConfig } from "@/lib/community";
import { emailKey } from "@/lib/learn";
import { requestCommunityLink } from "@/lib/community-access";
import { sendFeedLink } from "@/lib/podcast-access";
import { rememberBuyers, requestLibraryLink } from "@/lib/buyer-library";
import { communityWords } from "@/lib/buyer-words/community";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { POST as communityLinkRoute } from "@/app/api/store/community/link/route";
import { POST as podcastLinkRoute } from "@/app/api/store/podcast/link/route";
import { POST as libraryRoute } from "@/app/api/library/route";
import { store as redis } from "@/tests/redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";
import { afterTasks } from "./next-server-after-world";

const origin = "https://marktmorgen.com";
const buyer = "uniform-access-holder@example.test";
const stranger = "uniform-access-stranger@example.test";
type Command = (string | number)[];

const keysFrom = (prefix: string) => redis.keys().filter((k) => k.startsWith(prefix) && !k.endsWith(":opens")).length;
const communityLinks = () => keysFrom("nl:cm:link:");
const libraryLinks = () => keysFrom("nl:lib:link:");

/** Runs what the answers left for after them, as Next does once each answer is sent. */
async function drain(): Promise<number> {
  let ran = 0;
  while (afterTasks.length) {
    const task = afterTasks.shift() as () => unknown;
    await task();
    ran += 1;
  }
  return ran;
}

/** How long an answer takes, in milliseconds. */
async function timed<T>(ask: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await ask();
  return [value, performance.now() - start];
}

const SLOW_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A Stripe account that sold nothing to anybody: every list is empty.
const emptyStripe = () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });

async function mailWorld(slow = false) {
  delete process.env.RESEND_API_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_uniform_access_only_a_stand_in";
  afterTasks.length = 0;
  // A slow provider: SES takes SLOW_MS to answer each message, then answers as set.
  const fixture = installSesMailFixture({ fallback: emptyStripe, ...(slow ? { onSes: async () => { await sleep(SLOW_MS); return undefined; } } : {}) });
  redis.clear();
  fixture.configure();
  await fixture.setReady(true, { max24: 50_000, rate: 100 });
  return fixture;
}

async function paidStore(owner: string, handle: string) {
  assert.ok((await claimHandle(owner, handle, "Uniform Access", "")).ok);
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1UniformAccess001", true);
  await setSubscription(owner, { customerId: "cus_UniformAccess1", subscriptionId: "sub_UniformAccess1", active: true, tier: "creator", period: paidPeriod() });
}

async function communityWorld(handle: string, slow = false) {
  const fixture = await mailWorld(slow);
  const owner = `${handle}@example.test`;
  await paidStore(owner, handle);
  const ticket = await addProduct(owner, "Club pass", "", "0", null);
  assert.ok(ticket.ok);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const cid = store.community!.id;
  const config = { ...freshConfig(store.name), access: [ticket.product.id] };
  await saveConfig(cid, config);
  // The ticket's answer, kept as the gate keeps it: the holder holds one, the stranger does not.
  await redis.pipeline([
    ["SET", `nl:cm:${cid}:ok:${emailKey(buyer)}`, JSON.stringify({ v: config.v, ok: true })],
    ["SET", `nl:cm:${cid}:ok:${emailKey(stranger)}`, JSON.stringify({ v: config.v, ok: false })],
  ]);
  return { fixture, store };
}

async function podcastWorld(handle: string, slow = false) {
  const fixture = await mailWorld(slow);
  const owner = `${handle}@example.test`;
  await paidStore(owner, handle);
  const show = await addProduct(owner, "Uniform Radio", "", "19", null);
  assert.ok(show.ok);
  assert.ok((await setProductPodcast(owner, show.product.id, { id: "a".repeat(32), episodes: 0 })).ok);
  await setPodcastEpisodes(owner, show.product.id, 1);
  await setPastBuyers(owner);
  let store = (await storeForEmail(owner))!;
  // An independent right, written by its real function: synthetic, not a real purchase.
  await grantImported(store.statsId!, "gift:gft_uniform", [{ email: buyer, productId: show.product.id, items: null }]);
  store = (await storeForEmail(owner))!;
  const product = (await readListing(store, show.product.id))!;
  assert.ok(product.podcast);
  return { fixture, store, product };
}

async function libraryWorld(handle: string, slow = false) {
  const fixture = await mailWorld(slow);
  const owner = `${handle}@example.test`;
  await paidStore(owner, handle);
  const store = (await storeForEmail(owner))!;
  await rememberBuyers(store.sid, [buyer]);
  return { fixture, store };
}

/** Once a key with this prefix is written, every later Redis call fails (an outage), except removing that key. */
function outageAfter(prefix: string) {
  const original = redis.pipeline;
  const state = { armed: false, thrown: 0 };
  redis.pipeline = async (commands: Command[]) => {
    const removes = commands.every((c) => c[0] === "DEL" && String(c[1]).startsWith(prefix));
    if (state.armed && !removes) { state.thrown += 1; throw new Error("synthetic outage"); }
    const reply = await original(commands);
    if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith(prefix))) state.armed = true;
    return reply;
  };
  return { state, restore: () => { redis.pipeline = original; } };
}

const form = (path: string, ip: string, fields: Record<string, string>) =>
  new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams(fields),
  });

// ---- Community -------------------------------------------------------------------------------------

test("community: a refused final send gives the holder and a stranger the same reply and keeps no link", async () => {
  const { fixture, store } = await communityWorld("uniformclubrefused");
  try {
    fixture.setSesOutcome("refused");
    const entitled = await requestCommunityLink({ store, email: buyer, ip: "192.0.2.60", origin });
    const unentitled = await requestCommunityLink({ store, email: stranger, ip: "192.0.2.61", origin });
    await drain();
    assert.ok(fixture.calls.ses > 0, "the holder's send really reached SES and was refused");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled, "the reply never says whether the address holds a ticket");
    assert.equal(entitled, "sent");
    assert.equal(communityLinks(), 0, "the link of an email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("community: an outage after the link was written gives the same reply as a stranger and keeps no link", async () => {
  const { fixture, store } = await communityWorld("uniformclubthrown");
  const outage = outageAfter("nl:cm:link:");
  try {
    const entitled = await requestCommunityLink({ store, email: buyer, ip: "192.0.2.62", origin }).catch(() => "threw" as const);
    await drain();
    outage.state.armed = false;
    const unentitled = await requestCommunityLink({ store, email: stranger, ip: "192.0.2.63", origin });
    await drain();
    assert.ok(outage.state.thrown > 0, "the outage really happened after the link was written");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled);
    assert.equal(communityLinks(), 0);
  } finally {
    outage.restore();
    fixture.restore();
  }
});

test("community: the public route sends the holder and a stranger to the same place when the send fails", async () => {
  const { fixture, store } = await communityWorld("uniformclubroute");
  try {
    fixture.setSesOutcome("refused");
    const post = (email: string, ip: string) => communityLinkRoute(form("/api/store/community/link", ip, { handle: store.handle, email }));
    const a = await post(buyer, "192.0.2.64");
    const b = await post(stranger, "192.0.2.65");
    await drain();
    assert.ok(fixture.calls.ses > 0, "the holder's send really reached SES and was refused");
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.equal(communityLinks(), 0);
  } finally {
    fixture.restore();
  }
});

test("community: a delivered link is still sent and kept", async () => {
  const { fixture, store } = await communityWorld("uniformclubok");
  try {
    assert.equal(await requestCommunityLink({ store, email: buyer, ip: "192.0.2.66", origin }), "sent");
    await drain();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].text, /token=[a-f0-9]{64}/);
    assert.equal(communityLinks(), 1);
  } finally {
    fixture.restore();
  }
});

// ---- Private podcast -------------------------------------------------------------------------------

const podcastInput = (store: Awaited<ReturnType<typeof podcastWorld>>["store"], product: Awaited<ReturnType<typeof podcastWorld>>["product"], email: string, ip: string) =>
  ({ store, product, email, ip, base: `${origin}/@${store.handle}`, from: "Uniform <store@marktmorgen.com>" });

test("podcast: a refused final send gives the holder and a stranger the same reply", async () => {
  const { fixture, store, product } = await podcastWorld("uniformpodrefused");
  try {
    fixture.setSesOutcome("refused");
    const entitled = await sendFeedLink(podcastInput(store, product, buyer, "192.0.2.70"));
    const unentitled = await sendFeedLink(podcastInput(store, product, stranger, "192.0.2.71"));
    await drain();
    assert.ok(fixture.calls.ses > 0, "the holder's send really reached SES and was refused");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled, "the reply never says whether the address holds the podcast");
    assert.equal(entitled, "sent");
  } finally {
    fixture.restore();
  }
});

test("podcast: a feed that could not be made gives the holder the same reply as a stranger", async () => {
  const { fixture, store, product } = await podcastWorld("uniformpodnotoken");
  const original = redis.pipeline;
  let refused = 0;
  try {
    // Writing the address's feed fails (an outage on the order room): only a holder ever gets that far.
    redis.pipeline = async (commands: Command[]) => {
      if (commands.some((c) => String(c[0]).toUpperCase() === "EVAL" || String(c[1] ?? "").startsWith("nl:pod:by:") && c[0] === "SET")) {
        refused += 1;
        throw new Error("synthetic outage");
      }
      return original(commands);
    };
    const entitled = await sendFeedLink(podcastInput(store, product, buyer, "192.0.2.72")).catch(() => "threw" as const);
    const unentitled = await sendFeedLink(podcastInput(store, product, stranger, "192.0.2.73")).catch(() => "threw" as const);
    await drain();
    assert.ok(refused > 0, "the feed's write really failed");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled);
    assert.equal(entitled, "sent");
  } finally {
    redis.pipeline = original;
    fixture.restore();
  }
});

test("podcast: the public route sends the holder and a stranger to the same place when the send fails", async () => {
  const { fixture, store, product } = await podcastWorld("uniformpodroute");
  try {
    fixture.setSesOutcome("refused");
    const post = (email: string, ip: string) => podcastLinkRoute(form("/api/store/podcast/link", ip, { handle: store.handle, product: product.id, email }));
    const a = await post(buyer, "192.0.2.74");
    const b = await post(stranger, "192.0.2.75");
    await drain();
    assert.ok(fixture.calls.ses > 0, "the holder's send really reached SES and was refused");
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
  } finally {
    fixture.restore();
  }
});

test("podcast: the feed an address already has is never removed by a failed send", async () => {
  const { fixture, store, product } = await podcastWorld("uniformpodkeep");
  try {
    assert.equal(await sendFeedLink(podcastInput(store, product, buyer, "192.0.2.76")), "sent");
    await drain();
    const first = /\?t=([a-f0-9]{48})/.exec(fixture.sent.at(-1)!.text)?.[1];
    assert.ok(first, "a delivered email holds the feed");
    fixture.setSesOutcome("refused");
    assert.equal(await sendFeedLink(podcastInput(store, product, buyer, "192.0.2.77")), "sent");
    await drain();
    assert.ok(fixture.calls.ses > 1, "the second send really reached SES and was refused");
    assert.equal(keysFrom(`nl:pod:t:`), 1, "the apps already subscribed keep their feed");
  } finally {
    fixture.restore();
  }
});

// ---- Buyers' library -------------------------------------------------------------------------------

test("library: a refused final send gives a buyer and a stranger the same reply and keeps no link", async () => {
  const { fixture } = await libraryWorld("uniformlibrefused");
  try {
    fixture.setSesOutcome("refused");
    const entitled = await requestLibraryLink({ email: buyer, ip: "192.0.2.80", origin });
    const unentitled = await requestLibraryLink({ email: stranger, ip: "192.0.2.81", origin });
    await drain();
    assert.ok(fixture.calls.ses > 0, "the buyer's send really reached SES and was refused");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled, "the reply never says whether the address bought anything");
    assert.equal(entitled, "sent");
    assert.equal(libraryLinks(), 0, "the link of an email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("library: an outage after the link was written gives the same reply as a stranger and keeps no link", async () => {
  const { fixture } = await libraryWorld("uniformlibthrown");
  const outage = outageAfter("nl:lib:link:");
  try {
    const entitled = await requestLibraryLink({ email: buyer, ip: "192.0.2.82", origin }).catch(() => "threw" as const);
    await drain();
    outage.state.armed = false;
    const unentitled = await requestLibraryLink({ email: stranger, ip: "192.0.2.83", origin });
    await drain();
    assert.ok(outage.state.thrown > 0, "the outage really happened after the link was written");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled);
    assert.equal(libraryLinks(), 0);
  } finally {
    outage.restore();
    fixture.restore();
  }
});

test("library: the public route sends a buyer and a stranger to the same place when the send fails", async () => {
  const { fixture } = await libraryWorld("uniformlibroute");
  try {
    fixture.setSesOutcome("refused");
    const post = (email: string, ip: string) => libraryRoute(form("/api/library", ip, { email }));
    const a = await post(buyer, "192.0.2.84");
    const b = await post(stranger, "192.0.2.85");
    await drain();
    assert.ok(fixture.calls.ses > 0, "the buyer's send really reached SES and was refused");
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.equal(libraryLinks(), 0);
  } finally {
    fixture.restore();
  }
});

test("library: a delivered link is still sent and kept", async () => {
  const { fixture } = await libraryWorld("uniformlibok");
  try {
    assert.equal(await requestLibraryLink({ email: buyer, ip: "192.0.2.86", origin }), "sent");
    await drain();
    assert.equal(fixture.sent.length, 1);
    assert.equal(libraryLinks(), 1);
  } finally {
    fixture.restore();
  }
});

// ---- How long the answer takes ---------------------------------------------------------------------

/**
 * With a provider that takes SLOW_MS to answer, a holder's answer used to wait
 * on its email and a stranger's did not. Both now come back without waiting
 * on it: each well under SLOW_MS, and the email still goes out after them.
 */
async function sameTime(name: string, holder: () => Promise<unknown>, nobody: () => Promise<unknown>, fixture: { calls: { ses: number }; sent: unknown[] }) {
  const [a, holderMs] = await timed(holder);
  const [b, nobodyMs] = await timed(nobody);
  assert.equal(a, b, `${name}: the same words`);
  assert.ok(holderMs < SLOW_MS / 2, `${name}: the holder's answer did not wait on the email (${holderMs.toFixed(0)} ms)`);
  assert.ok(Math.abs(holderMs - nobodyMs) < SLOW_MS / 2, `${name}: the two answers take about as long (${holderMs.toFixed(0)} ms, ${nobodyMs.toFixed(0)} ms)`);
  assert.equal(fixture.calls.ses, 0, `${name}: nothing was sent before the answers`);
  const [, afterMs] = await timed(drain);
  assert.ok(afterMs >= SLOW_MS - 20, `${name}: the slow email really ran after the answer (${afterMs.toFixed(0)} ms)`);
  assert.equal(fixture.sent.length, 1, `${name}: and the holder's email went out`);
}

test("community: the holder's answer takes no longer than a stranger's with a slow provider", async () => {
  const { fixture, store } = await communityWorld("uniformclubslow", true);
  try {
    await sameTime("community",
      () => requestCommunityLink({ store, email: buyer, ip: "192.0.2.90", origin }),
      () => requestCommunityLink({ store, email: stranger, ip: "192.0.2.91", origin }), fixture);
  } finally {
    fixture.restore();
  }
});

test("podcast: the holder's answer takes no longer than a stranger's with a slow provider", async () => {
  const { fixture, store, product } = await podcastWorld("uniformpodslow", true);
  try {
    await sameTime("podcast",
      () => sendFeedLink(podcastInput(store, product, buyer, "192.0.2.92")),
      () => sendFeedLink(podcastInput(store, product, stranger, "192.0.2.93")), fixture);
  } finally {
    fixture.restore();
  }
});

test("library: a buyer's answer takes no longer than a stranger's with a slow provider", async () => {
  const { fixture } = await libraryWorld("uniformlibslow", true);
  try {
    await sameTime("library",
      () => requestLibraryLink({ email: buyer, ip: "192.0.2.94", origin }),
      () => requestLibraryLink({ email: stranger, ip: "192.0.2.95", origin }), fixture);
  } finally {
    fixture.restore();
  }
});

// ---- What the page says ----------------------------------------------------------------------------

// The notices before this fix promised a link "on its way" to an address that holds the thing.
const PROMISED = [
  /on its way/i, /(en|de) camino/i, /est en route/i, /unterwegs/i, /in arrivo/i, /onderweg/i, /a caminho/i,
];

test("the reply is honest when nothing was sent: no promise of a link, and what to do if none arrives, in every language", () => {
  for (const code of LANGUAGE_CODES) {
    const community = communityWords(code).linkNotices.sent;
    const podcast = (coursesWords(code).podcastNotices as unknown as Record<string, { title: string; body: string }>).sent;
    for (const [what, sent] of [["community", community], ["podcast", podcast]] as const) {
      assert.ok(sent.title.length > 0 && sent.body.length > 0, `${code} ${what}`);
      assert.ok(PROMISED.every((p) => !p.test(sent.body)), `${code} ${what}: never promises a link that may not have been sent`);
    }
  }
  assert.match(communityWords("en").linkNotices.sent.body, /ask again/i, "tells the member what to do if nothing arrives");
  assert.match((coursesWords("en").podcastNotices as unknown as Record<string, { body: string }>).sent.body, /ask again/i, "tells the listener what to do if nothing arrives");
  // The library is Marktmorgen's own page, in US English only.
  const library = /sent: \{ tone: "ok", text: "([^"]+)" \}/.exec(readFileSync("app/library/page.tsx", "utf8"))?.[1] ?? "";
  assert.ok(library.length > 0, "the library page's notice is found");
  assert.ok(PROMISED.every((p) => !p.test(library)), "the library never promises a link that may not have been sent");
  assert.match(library, /ask again/i, "tells the buyer what to do if nothing arrives");
});

// "?status=constructor" read with a bare index finds Object's own constructor, a
// function, and the page draws an empty notice in place of its words.
test("the pages read only the notices they have, never one inherited from Object", () => {
  assert.equal(typeof ({} as Record<string, unknown>)["constructor"], "function", "a bare index does find one");
  const reads: [string, RegExp, RegExp][] = [
    ["app/[handle]/community/page.tsx", /Object\.hasOwn\(links, asked\) \? links\[asked\]/, /linkNotices\(store\.language\)\[/],
    ["app/[handle]/community/page.tsx", /Object\.hasOwn\(notices, word\) \? notices\[word\]/, /notices\[word\] \?\?/],
    ["app/[handle]/podcast/[product]/page.tsx", /Object\.hasOwn\(w\.podcastNotices, status\) \? w\.podcastNotices\[status\]/, /= w\.podcastNotices\[status\];/],
    ["app/library/page.tsx", /Object\.hasOwn\(STATUS, query\.status\) \? STATUS\[query\.status\]/, /"string" \? STATUS\[query\.status\]/],
  ];
  for (const [file, guarded, bare] of reads) {
    const source = readFileSync(file, "utf8");
    assert.match(source, guarded, `${file}: the notice is read only when the page has it`);
    assert.doesNotMatch(source, bare, `${file}: no bare read is left`);
  }
});
