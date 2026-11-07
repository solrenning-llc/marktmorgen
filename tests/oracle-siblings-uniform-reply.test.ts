/**
 * Two more "send me a link" forms must not tell a stranger whether an address
 * is on the store's books: the members' "manage my membership" link and the
 * affiliate programme's "apply / sign in" link. The same defect as the course
 * link (claude5/course-link-uniform) and the community, podcast and library
 * links (tests/access-link-uniform-reply.test.ts).
 *
 * - requestManageLink (lib/membership-manage.ts) answered "sent" at once to an
 *   address with no membership, and, for a member, waited on the email and
 *   answered "error" when it could not go out. The member's answer also took
 *   longer: the Stripe search for their subscriptions, the link and the email.
 * - requestAffiliateLink (lib/affiliates.ts) emails every address, but a new
 *   applicant's email may use only the asked share of the store's access
 *   emails (lib/store-allowance-rules.ts ASKED_SHARE_BPS): once a stranger
 *   has spent that share on made-up addresses, an address already in the
 *   programme answered "sent" and any other "error", and at different speeds.
 *   A link whose email did not go out was kept for its hour.
 *
 * Now each answers "sent" right after the limits, and the lookup, the link and
 * the email run after it (next/server `after`, held here by
 * tests/next-server-after-world.ts and run by drain()); a link whose email
 * did not go out is deleted.
 *
 * Actual functions under test: requestManageLink, requestAffiliateLink and
 * their public routes, with MemoryRedis, the synthetic SES fixture and a
 * synthetic Stripe account (HTTP replies only, never the send result).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { requestManageLink } from "@/lib/membership-manage";
import { requestAffiliateLink } from "@/lib/affiliates";
import { forceAllowance } from "@/lib/store-allowance";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { membershipWords } from "@/lib/buyer-words/membership";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { POST as manageRoute } from "@/app/api/store/manage/route";
import { POST as applyRoute } from "@/app/api/store/affiliates/apply/route";
import { store as redis } from "@/tests/redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";
import { afterTasks } from "./next-server-after-world";

const origin = "https://marktmorgen.com";
const member = "uniform-sibling-member@example.test";
const stranger = "uniform-sibling-stranger@example.test";
const MEMBER_CUSTOMER = "cus_UniformSibling01";
type Command = (string | number)[];

const keysFrom = (prefix: string) => redis.keys().filter((k) => k.startsWith(prefix)).length;
const manageLinks = () => keysFrom("nl:manage:link:");
const affiliateLinks = () => keysFrom("nl:aff:link:");

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
const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });

/**
 * The creator's Stripe account: the member is a customer with a live
 * membership sold by this store; anybody else is no customer at all.
 */
function stripeFor(handle: string) {
  return (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/customers") {
      return list(url.searchParams.get("email") === member ? [{ id: MEMBER_CUSTOMER, created: 1 }] : []);
    }
    if (url.pathname === "/v1/subscriptions" && url.searchParams.get("customer") === MEMBER_CUSTOMER) {
      return list([{ id: "sub_UniformSibling01", status: "active", created: 2, metadata: { store: handle } }]);
    }
    return list([]);
  };
}

async function mailWorld(handle: string, slow = false) {
  delete process.env.RESEND_API_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_uniform_sibling_only_a_stand_in";
  afterTasks.length = 0;
  // A slow provider: SES takes SLOW_MS to answer each message, then answers as set.
  const fixture = installSesMailFixture({ fallback: stripeFor(handle), ...(slow ? { onSes: async () => { await sleep(SLOW_MS); return undefined; } } : {}) });
  redis.clear();
  fixture.configure();
  await fixture.setReady(true, { max24: 50_000, rate: 100 });
  return fixture;
}

async function paidStore(owner: string, handle: string) {
  assert.ok((await claimHandle(owner, handle, "Uniform Sibling", "")).ok);
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1UniformSibling01", true);
  await setSubscription(owner, { customerId: "cus_UniformSiblingOwn", subscriptionId: "sub_UniformSiblingOwn", active: true, tier: "creator", period: paidPeriod() });
}

async function membersWorld(handle: string, slow = false) {
  const fixture = await mailWorld(handle, slow);
  const owner = `${handle}@example.test`;
  await paidStore(owner, handle);
  return { fixture, store: (await storeForEmail(owner))! };
}

/**
 * A store with an affiliate programme, the member already in it (the record
 * its own link writes when opened, lib/affiliates.ts openAffiliateLink), and
 * the asked share of its access emails spent, as a stranger typing made-up
 * addresses into its forms would spend it.
 */
async function affiliatesWorld(handle: string, slow = false, spent = true) {
  const fixture = await mailWorld(handle, slow);
  const owner = `${handle}@example.test`;
  await paidStore(owner, handle);
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 0 });
  const store = (await storeForEmail(owner))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:emails`, member, "aaaaaaaaaaaa"]]);
  if (spent) {
    const asked = askedCeiling(allowanceFor(store, "transactional"));
    assert.ok(asked > 0 && asked < allowanceFor(store, "transactional"), "the asked share is part of the figure");
    assert.ok(await forceAllowance(store, "transactional", asked), "the asked share is spent");
  }
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

// ---- Members: "manage my membership" ---------------------------------------------------------------

test("membership: a refused final send gives a member and a stranger the same reply and keeps no link", async () => {
  const { fixture, store } = await membersWorld("uniformmanagerefused");
  try {
    fixture.setSesOutcome("refused");
    const entitled = await requestManageLink({ store, email: member, ip: "192.0.2.90", origin });
    const unentitled = await requestManageLink({ store, email: stranger, ip: "192.0.2.91", origin });
    await drain();
    assert.ok(fixture.calls.ses > 0, "the member's send really reached SES and was refused");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled, "the reply never says whether the address has a membership");
    assert.equal(entitled, "sent");
    assert.equal(manageLinks(), 0, "the link of an email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("membership: an outage after the link was written gives the same reply as a stranger and keeps no link", async () => {
  const { fixture, store } = await membersWorld("uniformmanagethrown");
  const outage = outageAfter("nl:manage:link:");
  try {
    const entitled = await requestManageLink({ store, email: member, ip: "192.0.2.92", origin }).catch(() => "threw" as const);
    await drain();
    outage.state.armed = false;
    const unentitled = await requestManageLink({ store, email: stranger, ip: "192.0.2.93", origin });
    await drain();
    assert.ok(outage.state.thrown > 0, "the outage really happened after the link was written");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled);
    assert.equal(manageLinks(), 0);
  } finally {
    outage.restore();
    fixture.restore();
  }
});

test("membership: the public route sends a member and a stranger to the same place when the send fails", async () => {
  const { fixture, store } = await membersWorld("uniformmanageroute");
  try {
    fixture.setSesOutcome("refused");
    const post = (email: string, ip: string) => manageRoute(form("/api/store/manage", ip, { handle: store.handle, email }));
    const a = await post(member, "192.0.2.94");
    const b = await post(stranger, "192.0.2.95");
    await drain();
    assert.ok(fixture.calls.ses > 0, "the member's send really reached SES and was refused");
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.equal(manageLinks(), 0);
  } finally {
    fixture.restore();
  }
});

test("membership: a delivered link is still sent and kept, and a stranger is sent nothing", async () => {
  const { fixture, store } = await membersWorld("uniformmanageok");
  try {
    assert.equal(await requestManageLink({ store, email: member, ip: "192.0.2.96", origin }), "sent");
    assert.equal(await requestManageLink({ store, email: stranger, ip: "192.0.2.97", origin }), "sent");
    await drain();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].text, /manage\?token=[a-f0-9]{64}/);
    assert.equal(manageLinks(), 1);
  } finally {
    fixture.restore();
  }
});

// ---- Affiliates: "apply / sign in" -----------------------------------------------------------------

test("affiliates: with the asked share spent, an address in the programme and a stranger get the same reply", async () => {
  const { fixture, store } = await affiliatesWorld("uniformaffspent");
  try {
    const known = await requestAffiliateLink({ store, email: member, note: "", ip: "192.0.2.100", origin });
    const unknown = await requestAffiliateLink({ store, email: stranger, note: "", ip: "192.0.2.101", origin });
    await drain();
    assert.equal(fixture.sent.length, 1, "the affiliate's own link still went, from the buyers' share");
    assert.deepEqual([fixture.sent[0].to].flat(), [member]);
    assert.equal(known, unknown, "the reply never says whether the address is in the programme");
    assert.equal(known, "sent");
    assert.equal(affiliateLinks(), 1, "the link of the stranger's email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("affiliates: a refused final send keeps no link", async () => {
  const { fixture, store } = await affiliatesWorld("uniformaffrefused", false, false);
  try {
    fixture.setSesOutcome("refused");
    const known = await requestAffiliateLink({ store, email: member, note: "", ip: "192.0.2.102", origin });
    const unknown = await requestAffiliateLink({ store, email: stranger, note: "", ip: "192.0.2.103", origin });
    await drain();
    assert.ok(fixture.calls.ses > 0, "the sends really reached SES and were refused");
    assert.equal(fixture.sent.length, 0);
    assert.deepEqual([known, unknown], ["sent", "sent"]);
    assert.equal(affiliateLinks(), 0, "the link of an email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("affiliates: the public route sends an affiliate and a stranger to the same place with the asked share spent", async () => {
  const { fixture, store } = await affiliatesWorld("uniformaffroute");
  try {
    const post = (email: string, ip: string) => applyRoute(form("/api/store/affiliates/apply", ip, { handle: store.handle, email, note: "" }));
    const a = await post(member, "192.0.2.104");
    const b = await post(stranger, "192.0.2.105");
    await drain();
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
  } finally {
    fixture.restore();
  }
});

test("affiliates: a delivered link is still sent and kept", async () => {
  const { fixture, store } = await affiliatesWorld("uniformaffok", false, false);
  try {
    assert.equal(await requestAffiliateLink({ store, email: stranger, note: "I write about bread", ip: "192.0.2.106", origin }), "sent");
    await drain();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].text, /affiliates\?token=[a-f0-9]{64}/);
    assert.equal(affiliateLinks(), 1);
  } finally {
    fixture.restore();
  }
});

/**
 * The link's SET answered with anything but exactly "OK" (rule 24; sibling of
 * signInLinkFor in claude5/signin-link-set-exact): no paid email carries a link
 * Redis did not say it stored, the reply stays "sent" for both addresses, and a
 * SET that did land but whose answer was lost is removed like an unsent link.
 */
const ODD_SET: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["a reply of another word", ["QUEUED"]],
  ["two replies for one command", ["OK", "OK"]],
];

/** The one-command SET of an affiliate link answered by `reply`; with `apply`, the SET is still made. */
function affiliateSetAnswered(reply: unknown[], apply: boolean) {
  const original = redis.pipeline;
  redis.pipeline = async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:aff:link:")) {
      if (apply) await original(commands);
      return reply;
    }
    return original(commands);
  };
  return () => { redis.pipeline = original; };
}

for (const apply of [false, true]) {
  for (const [what, reply] of ODD_SET) {
    test(`affiliates: a link SET ${apply ? "made" : "not made"} with ${what} sends no email, keeps no link and answers the same`, async () => {
      const { fixture, store } = await affiliatesWorld(`uniformaffset${apply ? "a" : "n"}${ODD_SET.findIndex(([w]) => w === what)}`, false, false);
      const restore = affiliateSetAnswered(reply, apply);
      try {
        const known = await requestAffiliateLink({ store, email: member, note: "", ip: "192.0.2.120", origin });
        const unknown = await requestAffiliateLink({ store, email: stranger, note: "", ip: "192.0.2.121", origin });
        await drain();
        assert.deepEqual([known, unknown], ["sent", "sent"], "the reply never says whether the address is in the programme");
        assert.equal(fixture.calls.ses, 0, "no paid email was tried with a link Redis did not say it stored");
        assert.equal(fixture.sent.length, 0);
        assert.equal(affiliateLinks(), 0, "a link whose SET was not confirmed is not left behind");
      } finally {
        restore();
        fixture.restore();
      }
    });
  }
}

/** The one-command SET of a membership link answered by `reply`; with `apply`, the SET is still made. */
function manageSetAnswered(reply: unknown[], apply: boolean) {
  const original = redis.pipeline;
  redis.pipeline = async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:manage:link:")) {
      if (apply) await original(commands);
      return reply;
    }
    return original(commands);
  };
  return () => { redis.pipeline = original; };
}

for (const apply of [false, true]) {
  for (const [what, reply] of ODD_SET) {
    test(`membership: a link SET ${apply ? "made" : "not made"} with ${what} sends no email, keeps no link and answers the same`, async () => {
      const { fixture, store } = await membersWorld(`uniformmanageset${apply ? "a" : "n"}${ODD_SET.findIndex(([w]) => w === what)}`);
      const restore = manageSetAnswered(reply, apply);
      try {
        const known = await requestManageLink({ store, email: member, ip: "192.0.2.130", origin });
        const unknown = await requestManageLink({ store, email: stranger, ip: "192.0.2.131", origin });
        await drain();
        assert.deepEqual([known, unknown], ["sent", "sent"], "the reply never says whether the address has a membership");
        assert.equal(fixture.calls.ses, 0, "no paid email was tried with a link Redis did not say it stored");
        assert.equal(fixture.sent.length, 0);
        assert.equal(manageLinks(), 0, "a link whose SET was not confirmed is not left behind");
      } finally {
        restore();
        fixture.restore();
      }
    });
  }
}

// ---- Time --------------------------------------------------------------------------------------------

/**
 * With a provider that takes SLOW_MS to answer, the address on the books
 * used to wait on it and the other did not: each answer now comes well under
 * SLOW_MS, and the email still goes out after them.
 */
async function sameTime(name: string, onBooks: () => Promise<string>, other: () => Promise<string>) {
  const [a, onBooksMs] = await timed(onBooks);
  const [b, otherMs] = await timed(other);
  assert.equal(a, b, `${name}: the same answer`);
  assert.ok(onBooksMs < SLOW_MS / 2, `${name}: the answer for the address on the books did not wait on the email (${onBooksMs.toFixed(0)} ms)`);
  assert.ok(Math.abs(onBooksMs - otherMs) < SLOW_MS / 2, `${name}: the two answers take about as long (${onBooksMs.toFixed(0)} ms, ${otherMs.toFixed(0)} ms)`);
  const [, afterMs] = await timed(drain);
  assert.ok(afterMs >= SLOW_MS - 20, `${name}: the slow email really ran after the answer (${afterMs.toFixed(0)} ms)`);
}

test("membership: a member's answer takes no longer than a stranger's with a slow provider", async () => {
  const { fixture, store } = await membersWorld("uniformmanageslow", true);
  try {
    await sameTime("membership",
      () => requestManageLink({ store, email: member, ip: "192.0.2.110", origin }),
      () => requestManageLink({ store, email: stranger, ip: "192.0.2.111", origin }));
    assert.equal(fixture.sent.length, 1);
  } finally {
    fixture.restore();
  }
});

test("affiliates: with the asked share spent, an affiliate's answer takes no longer than a stranger's with a slow provider", async () => {
  const { fixture, store } = await affiliatesWorld("uniformaffslow", true);
  try {
    await sameTime("affiliates",
      () => requestAffiliateLink({ store, email: member, note: "", ip: "192.0.2.112", origin }),
      () => requestAffiliateLink({ store, email: stranger, note: "", ip: "192.0.2.113", origin }));
    assert.equal(fixture.sent.length, 1);
  } finally {
    fixture.restore();
  }
});

// ---- Words -------------------------------------------------------------------------------------------

const PROMISED = [
  /on its way/i, /(en|de) camino/i, /est en route/i, /unterwegs/i, /in arrivo/i, /onderweg/i, /a caminho/i,
];

test("the reply is honest when nothing was sent: no promise of a link, and what to do if none arrives, in every language", () => {
  for (const code of LANGUAGE_CODES) {
    const bodies = [["membership", membershipWords(code).sentBody("Harbor")], ["affiliates", affiliatesWords(code).sentBody("Harbor")]] as const;
    for (const [what, body] of bodies) {
      assert.ok(PROMISED.every((p) => !p.test(body)), `${code} ${what}: never promises a link that may not have been sent`);
      assert.ok(body.includes("Harbor"), `${code} ${what}: still names the store it comes from`);
    }
  }
  assert.match(membershipWords("en").sentBody("Harbor"), /ask again/i, "tells the member what to do if nothing arrives");
  assert.match(affiliatesWords("en").sentBody("Harbor"), /ask again/i, "tells the affiliate what to do if nothing arrives");
});
