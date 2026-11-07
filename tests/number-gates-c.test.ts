/**
 * Counters read in their exact shape before what they guard (audit SG2,
 * CX-123 rule 24; the margin rule's ceiling before every cost), third batch.
 *
 * Counters were read with Number(...): a reply that was missing, cut short,
 * of another shape or never came read as NaN (never past a ceiling) or as
 * 0/1 (always within it), so the email, the write or the access behind it
 * went ahead on a count nobody had. Each is called here as its route calls
 * it, on the in-memory store, with only the counter's own pipeline answered
 * differently:
 *
 *   - lib/community-access.ts requestCommunityLink: requests an hour, before the access email;
 *   - lib/community-access.ts openCommunityLink: opens of an emailed link, before the pass is given;
 *   - lib/affiliates.ts requestAffiliateLink: requests an hour, before the application email;
 *   - lib/affiliates.ts recordClick: clicks an hour from one connection, before a click is counted;
 *   - lib/buyer-orders.ts requestOrdersLink: requests an hour, before the purchases email;
 *   - lib/community.ts within: posts, comments, likes and messages an hour, before each is written;
 *   - app/api/creators/route.ts POST: answers an hour, before the answer is kept.
 *
 * An unknown reply is refused with the answer the code already gives when
 * something failed, and nothing behind the counter happens. A confirmed
 * count within the ceiling still goes through, and one past it is refused as
 * before.
 */
import { NextRequest } from "next/server";
import { POST as creatorsRoute } from "@/app/api/creators/route";
import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { openCommunityLink, requestCommunityLink } from "@/lib/community-access";
import { communityViewer } from "@/lib/community-access";
import { freshConfig, readMember, saveConfig, within } from "@/lib/community";
import { parseChatSetting, room } from "@/lib/community-chat";
import { parseDmSetting } from "@/lib/community-dm";
import { communityWords } from "@/lib/buyer-words/community";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { GET as openRoute } from "@/app/api/store/community/open/route";
import { POST as chatRoute } from "@/app/api/store/community/chat/route";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { recordClick, requestAffiliateLink } from "@/lib/affiliates";
import { requestOrdersLink } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setAffiliateSetting, setCommunity, setLanguage, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** Which pipeline is the counter's, and what it answers instead ("throw" for one that never answers). */
let counter: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
let counterCalls = 0;
/** Every command that reached the store, to see what was written after the counter. */
const seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (counter && counter.match(commands)) {
    counterCalls++;
    if (counter.reply === "throw") throw new Error("the database did not answer");
    return counter.reply;
  }
  seen.push(...commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

const mails: string[] = [];
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(String(init?.body ?? ""));
    return answer({ id: `email_${mails.length}` });
  }
  if (url.hostname === "api.stripe.com") stripeCalls++;
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What a call answered, or that it threw and with what. */
async function outcome<T>(call: () => Promise<T>): Promise<T | string> {
  try {
    return await call();
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : "something"}`;
  }
}

/** Replies of a SET ... NX then INCR pipeline that are not a confirmed count. */
const SET_INCR_UNKNOWN: [string, unknown][] = [
  ["a SET answered false", [false, 1]],
  ["a SET answered as a number", [1, 1]],
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a count of zero after INCR", ["OK", 0]],
  ["a count that is true", ["OK", true]],
  ["a count that is not whole", ["OK", 1.5]],
  ["a count that is negative", ["OK", -1]],
  ["a count written as empty text", ["OK", ""]],
  ["a reply that is not a list", { x: 1 }],
  ["a reply cut short", ["OK"]],
  ["an empty reply", []],
  ["a reply too long", ["OK", 1, 1]],
  ["a counter that never answers", "throw"],
];

const key = (command: Command | undefined) => String(command?.[1] ?? "");
/** A SET ... NX then INCR pipeline on a key starting with `prefix`. */
const setIncr = (prefix: string) => (commands: Command[]) =>
  commands.length === 2 && commands[0]?.[0] === "SET" && key(commands[0]).startsWith(prefix) && commands[1]?.[0] === "INCR";
const wroteSince = (from: number, test: (c: Command) => boolean) => seen.slice(from).filter(test).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_number_gates_c_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const OWNER = "owner@numbergatesc.example";
  const made = await claimHandle(OWNER, "numbergatesc", "Number Gates C", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1NumberGatesCCC", true);
  await setSubscription(OWNER, { customerId: "cus_NumberGatesC1", subscriptionId: "sub_NumberGatesC1", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const base: Store = (await storeForEmail(OWNER))!;
  const ORIGIN = "https://marktmorgen.com";
  /** A connection of its own for each request, so only the counter under test decides. */
  let host = 0;
  const ip = () => `203.0.${Math.floor((host += 1) / 250)}.${host % 250}`;

  part("Community posts, comments, likes and messages counted before each is written (lib/community.ts within)");
  {
    const id = "c".repeat(32);
    const isRate = setIncr(`nl:cm:rl:${id}:`);
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isRate, reply };
      const calls = counterCalls;
      const got = await outcome(() => within(id, "member-one", "post"));
      const want = reply === "throw" ? "threw Error" : "threw UnknownReplyError";
      is(`${label}: never taken as room, thrown to the route's "error"`, [got, counterCalls - calls], [want, 1]);
    }
    counter = { match: isRate, reply: ["OK", 1] };
    is("a confirmed first post is allowed", await within(id, "member-one", "post"), true);
    counter = { match: isRate, reply: [null, 5] };
    is("a confirmed fifth post in the hour is allowed", await within(id, "member-one", "post"), true);
    counter = { match: isRate, reply: [null, 6] };
    is("a confirmed sixth post is refused as before", await within(id, "member-one", "post"), false);
    counter = null;
  }

  part("Asking for a community link: requests counted before the access email (lib/community-access.ts)");
  {
    const id = "d".repeat(32);
    await saveConfig(id, freshConfig(base.name));
    const store: Store = { ...base, community: { id, on: true } };
    let n = 0;
    const ask = () => outcome(() => requestCommunityLink({ store, email: `member${(n += 1)}@numbergatesc.example`, ip: ip(), origin: ORIGIN }));
    const linkWrites = (from: number) => wroteSince(from, (c) => c[0] === "SET" && key(c).startsWith("nl:cm:link:"));
    for (const [which, prefix] of [["per connection", "nl:rl:cm:ip:"], ["per address", "nl:rl:cm:addr:"]] as const) {
      for (const [label, reply] of SET_INCR_UNKNOWN) {
        counter = { match: setIncr(prefix), reply };
        const [calls, sent, from] = [counterCalls, mails.length, seen.length];
        const got = await ask();
        const want = reply === "throw" ? "threw Error" : "error";
        is(`${which}, ${label}: "error", no email, no link kept`, [got, counterCalls - calls, mails.length - sent, linkWrites(from)], [want, 1, 0, 0]);
      }
    }
    counter = { match: setIncr("nl:rl:cm:ip:"), reply: ["OK", 1] };
    is("a confirmed count within both ceilings goes on to the ticket check, as before", await ask(), "sent");
    counter = { match: setIncr("nl:rl:cm:ip:"), reply: [null, 11] };
    is("a confirmed count past the connection's ceiling is limited, as before", await ask(), "limited");
    counter = { match: setIncr("nl:rl:cm:addr:"), reply: [null, 6] };
    is("a confirmed count past the address's ceiling is limited, as before", await ask(), "limited");
    counter = null;
  }

  part("Opening a community link: opens counted before the pass is given (lib/community-access.ts)");
  {
    const token = "e".repeat(64);
    const grant = JSON.stringify({ e: "member@numbergatesc.example", k: "storekey", h: base.handle });
    const isOpen = (commands: Command[]) =>
      commands.length === 3 && commands[0]?.[0] === "GET" && key(commands[0]).startsWith("nl:cm:link:") && commands[2]?.[0] === "INCR";
    const unknown: [string, unknown][] = [
      ...SET_INCR_UNKNOWN.map(([label, reply]): [string, unknown] => [label, Array.isArray(reply) ? [grant, ...reply] : reply]),
      ["the grant answered as a number", [5, "OK", 1]],
      ["the grant answered as a list", [[], "OK", 1]],
    ];
    for (const [label, reply] of unknown) {
      counter = { match: isOpen, reply };
      const calls = counterCalls;
      const got = await outcome(() => openCommunityLink(token));
      const want = reply === "throw" ? "threw Error" : "threw UnknownReplyError";
      is(`${label}: no pass given, thrown to the route`, [got, counterCalls - calls], [want, 1]);
    }
    counter = { match: isOpen, reply: [grant, "OK", 1] };
    is("a confirmed first open gives the grant", await openCommunityLink(token), JSON.parse(grant));
    counter = { match: isOpen, reply: [grant, null, 10] };
    is("a confirmed tenth open still gives it", await openCommunityLink(token), JSON.parse(grant));
    counter = { match: isOpen, reply: [grant, null, 11] };
    is("a confirmed eleventh open is refused as used, as before", await openCommunityLink(token), null);
    counter = { match: isOpen, reply: [null, "OK", 1] };
    is("a link that is gone is refused as expired, as before", await openCommunityLink(token), null);
    counter = null;
  }

  part("Applying as an affiliate: requests counted before the email (lib/affiliates.ts requestAffiliateLink)");
  {
    let n = 0;
    const ask = () => outcome(() => requestAffiliateLink({ store: base, email: `applicant${(n += 1)}@numbergatesc.example`, note: "", ip: ip(), origin: ORIGIN }));
    const linkWrites = (from: number) => wroteSince(from, (c) => c[0] === "SET" && key(c).startsWith("nl:aff:link:"));
    for (const [which, prefix] of [["per connection", "nl:rl:aff:ip:"], ["per address", "nl:rl:aff:addr:"]] as const) {
      for (const [label, reply] of SET_INCR_UNKNOWN) {
        counter = { match: setIncr(prefix), reply };
        const [calls, sent, from] = [counterCalls, mails.length, seen.length];
        const got = await ask();
        const want = reply === "throw" ? "threw Error" : "error";
        is(`${which}, ${label}: "error", no email, no link kept`, [got, counterCalls - calls, mails.length - sent, linkWrites(from)], [want, 1, 0, 0]);
      }
    }
    counter = { match: setIncr("nl:rl:aff:ip:"), reply: ["OK", 1] };
    {
      const sent = mails.length;
      is("a confirmed count within both ceilings: the link is emailed", [await ask(), mails.length - sent], ["sent", 1]);
    }
    counter = { match: setIncr("nl:rl:aff:ip:"), reply: [null, 11] };
    is("a confirmed count past the connection's ceiling is limited, as before", await ask(), "limited");
    counter = { match: setIncr("nl:rl:aff:addr:"), reply: [null, 6] };
    is("a confirmed count past the address's ceiling is limited, as before", await ask(), "limited");
    counter = null;
  }

  part("A click on an affiliate's link: clicks an hour counted before it is (lib/affiliates.ts recordClick)");
  {
    const statsId = base.statsId!;
    const ANA = "aaaaaaaaaaaa";
    await redis.pipeline([
      ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@numbergatesc.example", code: "ana", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })],
      ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
      ["HSET", `nl:aff:${statsId}:emails`, "ana@numbergatesc.example", ANA],
    ]);
    const isClick = setIncr("nl:rl:aff:click:");
    let n = 0;
    const click = () => outcome(() => recordClick(base, "ana", { ip: "198.51.100.4", userAgent: `agent-${(n += 1)}`, session: undefined }));
    const counted = (from: number) => wroteSince(from, (c) => (c[0] === "HINCRBY" && key(c).endsWith(":clicks")) || key(c).startsWith("nl:aff:seen:"));
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isClick, reply };
      const [calls, from] = [counterCalls, seen.length];
      const got = await click();
      const want = reply === "throw" ? "threw Error" : "threw UnknownReplyError";
      is(`${label}: not counted, thrown to the visit's log`, [got, counterCalls - calls, counted(from)], [want, 1, 0]);
    }
    counter = { match: isClick, reply: ["OK", 1] };
    {
      const from = seen.length;
      is("a confirmed first click is counted", [await click(), counted(from) > 0], [true, true]);
    }
    counter = { match: isClick, reply: [null, 31] };
    {
      const from = seen.length;
      is("a confirmed count past the hour's clicks is not counted, as before", [await click(), counted(from)], [false, 0]);
    }
    counter = null;
  }

  part("Asking for a purchases link: requests counted before anything is read or emailed (lib/buyer-orders.ts)");
  {
    let n = 0;
    const ask = () => outcome(() => requestOrdersLink({ store: base, email: `buyer${(n += 1)}@numbergatesc.example`, ip: ip(), origin: ORIGIN }));
    const after = (from: number) => wroteSince(from, (c) => key(c).startsWith("nl:orders:"));
    for (const [which, prefix] of [["per connection", "nl:rl:orders:ip:"], ["per address", "nl:rl:orders:addr:"]] as const) {
      for (const [label, reply] of SET_INCR_UNKNOWN) {
        counter = { match: setIncr(prefix), reply };
        const [calls, sent, stripe, from] = [counterCalls, mails.length, stripeCalls, seen.length];
        const got = await ask();
        const want = reply === "throw" ? "threw Error" : "error";
        is(`${which}, ${label}: "error", nothing taken, read or emailed`, [got, counterCalls - calls, mails.length - sent, stripeCalls - stripe, after(from)], [want, 1, 0, 0, 0]);
      }
    }
    counter = { match: setIncr("nl:rl:orders:ip:"), reply: ["OK", 1] };
    {
      const got = await ask();
      is("a confirmed count within both ceilings goes on past the limits, as before", got === "sent" || got === "busy", true);
    }
    counter = { match: setIncr("nl:rl:orders:ip:"), reply: [null, 11] };
    is("a confirmed count past the connection's ceiling is limited, as before", await ask(), "limited");
    counter = { match: setIncr("nl:rl:orders:addr:"), reply: [null, 6] };
    is("a confirmed count past the address's ceiling is limited, as before", await ask(), "limited");
    counter = null;
  }

  part("Answering the creator research: answers an hour counted before one is kept (app/api/creators/route.ts)");
  {
    const payload = {
      name: "Synthetic Creator", email: "creator@numbergatesc.example", platform: "Other",
      country: "Test country", problem: "A synthetic research answer for a regression test.",
      link: "", tools: "", cost: "", consentResearch: true, consentFollowUp: false, consentUpdates: false, website: "",
    };
    const ask = async () => {
      const response = await creatorsRoute(
        new NextRequest("https://marktmorgen.com/api/creators", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com", "x-forwarded-for": "192.0.2.40" },
          body: JSON.stringify(payload),
        }),
      );
      return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
    };
    const isRate = setIncr("nl:rl:creators:");
    const kept = (from: number) => wroteSince(from, (c) => c[0] === "LPUSH" && key(c) === RESPONSES_KEY);
    const quiet = console.error;
    console.error = () => {};
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isRate, reply };
      const [calls, from] = [counterCalls, seen.length];
      const got = await ask();
      is(`${label}: 500 server_error, nothing kept`, [got, counterCalls - calls, kept(from)], [[500, "server_error"], 1, 0]);
    }
    console.error = quiet;
    counter = { match: isRate, reply: ["OK", 1] };
    {
      const from = seen.length;
      is("a confirmed first answer is kept", [await ask(), kept(from)], [[201, "ok"], 1]);
    }
    counter = { match: isRate, reply: [null, 6] };
    {
      const from = seen.length;
      is("a confirmed sixth answer in the hour is refused as before", [await ask(), kept(from)], [[429, "rate_limited"], 0]);
    }
    counter = null;
  }

  // ---- The community's own routes, called as a member's browser calls them ----------------------------
  // A paying store with its community on, the room and private messages open, one product that lets in,
  // and a member holding it (the ticket's answer kept as the gate keeps it), named, with a pass cookie.
  // The store writes in Spanish, so what a route says is seen to be in the store's language.
  const CLUB = "club@numbergatesc.example";
  const MEMBER = "member@numbergatesc.example";
  const clubMade = await claimHandle(CLUB, "numbergatesclub", "Number Gates Club", "");
  if (!clubMade.ok) throw new Error("no club store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_NumberGatesC2", subscriptionId: "sub_NumberGatesC2", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  await setLanguage(CLUB, "es");
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], chat: parseChatSetting({ on: true }), dm: parseDmSetting({ on: true, between: true }) });
  await redis.pipeline([["SET", `nl:cm:${cid}:ok:${emailKey(MEMBER)}`, JSON.stringify({ v: 1, ok: true })]]);
  const cookie = `${passCookieName(club)}=${await mintPass(club, MEMBER, "all")}`;
  const viewer = await communityViewer(club, { get: (name: string) => (name === passCookieName(club) ? { value: cookie.split("=")[1] } : undefined) } as never);
  if (viewer.state !== "in" || !viewer.member) throw new Error("the member is not in: " + viewer.state);
  const memberKey = viewer.key;
  // The name the member is seen by, written as the record keeps it (setProfile's compare-and-set runs a script the stand-in does not).
  const [record] = await redis.pipeline([["HGET", `nl:cm:${cid}:m`, memberKey]]);
  await redis.pipeline([["HSET", `nl:cm:${cid}:m`, memberKey, JSON.stringify({ ...JSON.parse(String(record)), n: "Member One" })]]);
  if (!(await readMember(cid, memberKey))?.n) throw new Error("no name");
  const es = communityWords("es").notices;
  const en = communityWords("en").notices;
  const rateIs = (kind: string) => (commands: Command[]) =>
    commands.length === 2 && commands[0]?.[0] === "SET" && key(commands[0]) === `nl:cm:rl:${cid}:${memberKey}:${kind}` && commands[1]?.[0] === "INCR";
  const quietly = async <T>(call: () => Promise<T>) => {
    const quiet = console.error;
    console.error = () => {};
    try {
      return await outcome(call);
    } finally {
      console.error = quiet;
    }
  };
  /** Status, body and the headers that matter, or what the route threw. */
  const read = async (call: () => Promise<Response>) => {
    const got = await quietly(call);
    if (typeof got === "string") return got;
    return { status: got.status, store: got.headers.get("cache-control"), cookie: got.headers.get("set-cookie") !== null, location: got.headers.get("location"), body: got.status === 303 ? "" : await got.text() };
  };

  part("The room's route: a count it cannot read answers 503 with the room's own words, nothing said (app/api/store/community/chat/route.ts)");
  {
    let n = 0;
    const say = () =>
      chatRoute(
        new NextRequest("https://marktmorgen.com/api/store/community/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com", cookie },
          body: JSON.stringify({ handle: club.handle, action: "say", text: `Room message ${(n += 1)}` }),
        }),
      );
    const said = async () => (await room(cid, 0)).messages.length;
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: rateIs("comment"), reply };
      const before = await said();
      const got = await read(say);
      is(`${label}: 503 "unknown", not stored, nothing said`, [got, (await said()) - before], [{ status: 503, store: "no-store", cookie: false, location: null, body: JSON.stringify({ ok: false, error: "unknown" }) }, 0]);
    }
    counter = { match: rateIs("comment"), reply: ["OK", 1] };
    {
      const before = await said();
      const got = await read(say);
      is("a confirmed count: the message is said, as before", [typeof got === "object" && got.status, (await said()) - before], [200, 1]);
    }
    counter = { match: rateIs("comment"), reply: [null, 31] };
    {
      const got = await read(say);
      is("a confirmed count past the hour's messages: 429 hourly, as before", typeof got === "object" && [got.status, got.body], [429, JSON.stringify({ ok: false, error: "hourly" })]);
    }
    counter = null;
  }

  part("Private messages: a count it cannot read answers 503 in the store's language, nothing sent (app/api/store/community/messages/route.ts)");
  {
    let n = 0;
    const post = (fields: Record<string, string>) => () =>
      messagesRoute(
        new NextRequest("https://marktmorgen.com/api/store/community/messages", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: "marktmorgen.com", cookie },
          body: new URLSearchParams({ handle: club.handle, ...fields }).toString(),
        }),
      );
    const send = () => post({ action: "send", to: "creator", text: `A private message ${(n += 1)}` })();
    const dmWrites = (from: number) => wroteSince(from, (c) => key(c).includes(":dm:"));
    for (const kind of ["dm", "dmNew"]) {
      for (const [label, reply] of SET_INCR_UNKNOWN) {
        counter = { match: rateIs(kind), reply };
        const from = seen.length;
        const got = await read(send);
        is(`${kind}, ${label}: 503 "nothing was changed" in Spanish, nothing sent`, [got, dmWrites(from)], [{ status: 503, store: "no-store", cookie: false, location: null, body: es.error }, 0]);
      }
    }
    // Once the message is being written, whether it went in is not known: the person is asked to look first.
    counter = { match: (commands) => commands.some((c) => key(c).includes(":dm:")), reply: "throw" };
    is("Redis lost while the message is written: 503 \"could not confirm\" in Spanish", await read(send), { status: 503, store: "no-store", cookie: false, location: null, body: es.unconfirmed });
    counter = null;
    {
      const got = await read(send);
      is("confirmed counts: sent, as before", typeof got === "object" && [got.status, /n=dm(sent|asked)/.test(got.location ?? "")], [303, true]);
    }
    counter = { match: rateIs("dm"), reply: [null, 61] };
    {
      const got = await read(send);
      is("a confirmed count past the hour's messages: slow, as before", typeof got === "object" && [got.status, /n=slow/.test(got.location ?? "")], [303, true]);
    }
    counter = null;
  }

  part("Opening an emailed link: opens it cannot count answer 503, no pass given (app/api/store/community/open/route.ts)");
  {
    const sent = mails.length;
    if ((await requestCommunityLink({ store: club, email: MEMBER, ip: ip(), origin: ORIGIN })) !== "sent" || mails.length - sent !== 1) throw new Error("no community link");
    const token = mails.at(-1)!.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
    const openIt = () => openRoute(new NextRequest(`https://marktmorgen.com/api/store/community/open?token=${token}`, { headers: { Host: "marktmorgen.com" } }));
    const isOpen = (commands: Command[]) =>
      commands.length === 3 && commands[0]?.[0] === "GET" && key(commands[0]).startsWith("nl:cm:link:") && commands[2]?.[0] === "INCR";
    const passes = (from: number) => wroteSince(from, (c) => c[0] === "SET" && key(c).startsWith("nl:learn:"));
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isOpen, reply: Array.isArray(reply) ? [null, ...reply] : reply };
      const from = seen.length;
      const got = await read(openIt);
      // A gone link with an unknown count is still unknown: nothing tells it from a link that is there.
      is(`${label}: 503 "nothing was changed", no pass, no cookie`, [got, passes(from)], [{ status: 503, store: "no-store", cookie: false, location: null, body: en.error }, 0]);
    }
    // The store is known once the link is read: what fails after that is said in its language.
    counter = { match: (commands) => commands[0]?.[0] === "SET" && key(commands[0]).startsWith("nl:learn:"), reply: "throw" };
    is("Redis lost while the pass is written: 503 in Spanish, no cookie", await read(openIt), { status: 503, store: "no-store", cookie: false, location: null, body: es.error });
    counter = null;
    {
      const got = await read(openIt);
      is("a confirmed count: the pass is given, as before", typeof got === "object" && [got.status, got.cookie], [303, true]);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
