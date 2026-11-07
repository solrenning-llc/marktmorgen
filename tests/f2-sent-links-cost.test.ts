/**
 * What changing a sent email's link and opening one cost, measured on the
 * real database calls (124 [F2-EDIT-SENT-LINKS], #3034; follow-up to Codex P
 * 5808315232 and Codex J 5808324331, whose fix writes with APPEND_SENT_LINK).
 *
 * Three things the fix left without a demonstration, held here with
 * synthetic stores only (no email sent, no provider, no account):
 *
 *   1. The whole change request (POST /api/store/mail/links), from the
 *      session to the answer, at its worst: the email at its longest, its
 *      history one change short of full with every address at its longest
 *      in bytes, and each way it can end (saved; "busy" after every write
 *      found another change first; the write's answer lost and read back;
 *      a full history; a first change that meets another's new record).
 *      Every command is counted as Upstash bills it, the ones a script runs
 *      inside included (APPEND_SENT_LINK's GET and SET, TAKE_DATA's reads
 *      and writes), and every byte both ways as sent (JSON). At each call,
 *      what was sent so far is inside the studio requests already taken: a
 *      studio request is twenty commands and fifty kilobytes
 *      (tests/plan-cost-registry.ts, UNIT_COST.studio). The change's own
 *      requests are taken before the email or its history is read, and a
 *      store without them reads neither.
 *   2. The history's ceiling in UTF-8 bytes, which the 1,000-character limit
 *      does not give by itself: what is written is never past
 *      SENT_LINK_RECORD_MAX_BYTES, checked on the server before writing, and
 *      an address that is not well-formed text (a lone surrogate, written
 *      as six bytes) is refused.
 *   3. One opening of a link (/go): every command and byte it reads with
 *      the history at its longest, against what it is counted as, one of
 *      the store's public requests (SENT_LINK_REQUEST_UNITS, priced at a
 *      later page, tests/traffic-cost.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast, readBroadcast } from "@/lib/broadcasts";
import { broadcastCampaign } from "@/lib/mail-links";
import * as rules from "@/lib/sent-link-rules";
import { SENT_LINK_CHANGES_MAX, SENT_LINK_MAX_LENGTH, SENT_LINK_REQUEST_UNITS, currentOf, destinationProblem, linksOf } from "@/lib/sent-link-rules";
import { type SentEmail, APPEND_SENT_LINK, changeLink, readSentLinks, sentLinkKey, sentLinksFor } from "@/lib/sent-links";
import { TAKE_DATA } from "@/lib/store-data";
import { POST } from "@/app/api/store/mail/links/route";
import { GET } from "@/app/go/[handle]/[id]/[link]/route";
import { ORIGIN_PER_BYTE, request as costOf } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_COMMANDS = 20;
const UNIT_BYTES = 50_000;

type Command = (string | number)[];
type Event = { kind: "pay"; units: number } | { kind: "db"; commands: number; bytes: number; reads: string[] };

const OWNER = "costs@example.com";
const wire = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/** The longest address link `n` (youtube.com) can go to, in characters, made of `unit` (a 3-byte character, or a 4-byte pair). */
function longest(n: number, k: number, unit = "中"): string {
  const head = `https://youtube.com/watch?v=${n}&k=${k}&q=`;
  return head + unit.repeat(Math.floor((SENT_LINK_MAX_LENGTH - head.length) / unit.length));
}

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "costshop", "Cost Shop", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Costs00001", subscriptionId: "sub_Costs00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Cost Shop", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);

  /** An email at its longest on the wire: twenty links, then characters JSON writes as six bytes each, and sent. */
  const makeSent = async (subject: string): Promise<{ id: string; body: string; email: SentEmail }> => {
    const links = Array.from({ length: rules.SENT_LINKS_MAX }, (_, i) => `https://youtube.com/watch?v=${i}`);
    let body = `${links.join("\n\n")}\n\n`;
    body += `x${"\u0001".repeat(20_000 - body.length - 2)}x`;
    const created = await createBroadcast(store, { subject, body, productId: "", notProductId: "", sendAt: undefined });
    if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
    const key = `nl:mail:bc:${created.broadcast.id}`;
    const [raw] = await redis.pipeline([["GET", key]]);
    const record = JSON.parse(raw as string);
    record.sent = 1;
    record.status = "sent";
    await redis.pipeline([["SET", key, JSON.stringify(record)]]);
    const email = (await readBroadcast(created.broadcast.id))!;
    return { id: email.id, body: email.body, email };
  };
  const worst = await makeSent("S".repeat(150));
  is("the email has as many links as can be changed", linksOf(worst.body).length, rules.SENT_LINKS_MAX);
  is("the email is at its longest", worst.body.length, 20_000);

  const now = Math.floor(Date.now() / 1000);
  /** A history of `count` changes, every address at its longest in bytes. */
  const history = (count: number, exp = now + 300 * 86_400, salt = 0) =>
    JSON.stringify({ l: store.listId, exp, changes: Array.from({ length: count }, (_, i) => ({ n: 19, to: longest(19, i + salt), at: now })) });
  const almost = history(SENT_LINK_CHANGES_MAX - 1);

  // ------------------------------------------------------------- watching
  const pipeline = redis.pipeline.bind(redis);
  let events: Event[] = [];
  let interlope: ((batch: Command[]) => Promise<"lose" | void>) | null = null;
  /** TAKE_DATA's calls inside, at the most: the total and the month list read, each past month read and dropped, the slot read and written, the list and the total written. */
  const dataInside = async (batch: Command[]): Promise<number> => {
    let inside = 0;
    for (const c of batch) {
      if (c[0] !== "EVAL" || c[1] !== TAKE_DATA) continue;
      const [listed] = (await pipeline([["HGET", String(c[3]), "~"]])) as (string | null)[];
      const month = String(c[6]);
      const past = String(listed ?? "").split(",").filter((m) => m && m < month).length;
      inside += 6 + 2 * past;
    }
    return inside;
  };
  const watch = () => {
    events = [];
    redis.pipeline = (async (batch: Command[]) => {
      const studio = batch.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"));
      const isWrite = batch.length === 1 && batch[0][0] === "EVAL" && batch[0][1] === APPEND_SENT_LINK;
      const reads = batch.filter((c) => c[0] === "GET").map((c) => String(c[1]));
      const fate = isWrite && interlope ? await interlope(batch) : undefined;
      if (fate === "lose") {
        events.push({ kind: "db", commands: 1, bytes: wire(batch), reads });
        throw new Error("connection reset");
      }
      const inner = redis.scriptCalls;
      const inData = await dataInside(batch);
      const replies = await pipeline(batch);
      events.push({ kind: "db", commands: batch.length + (redis.scriptCalls - inner) + inData, bytes: wire(batch) + wire(replies), reads });
      if (studio) events.push({ kind: "pay", units: Number(studio[2]) });
      return replies;
    }) as typeof redis.pipeline;
  };
  const unwatch = () => {
    redis.pipeline = pipeline as typeof redis.pipeline;
    interlope = null;
  };

  /**
   * Whether every call was inside what was already paid when it was sent, counted together. The request's own
   * studio request is taken after the session and the store are read, as for every studio route: it is counted
   * from the start. Every other one counts from when it is taken.
   */
  const covered = (log: Event[]) => {
    let paid = 1;
    let firstPay = true;
    let commands = 0;
    let bytes = 0;
    let ok = true;
    for (const event of log) {
      if (event.kind === "pay") {
        if (firstPay) firstPay = false;
        else paid += event.units;
        continue;
      }
      commands += event.commands;
      bytes += event.bytes;
      if (commands > paid * UNIT_COMMANDS || bytes > paid * UNIT_BYTES) ok = false;
    }
    return { ok, paid, commands, bytes };
  };
  /** Whether the change's own studio requests were taken before the email or its history was first read. */
  const paidBeforeReading = (log: Event[], id: string) => {
    const read = log.findIndex((e) => e.kind === "db" && e.reads.some((k) => k === `nl:mail:bc:${id}` || k === sentLinkKey(id)));
    const pays = log.slice(0, read < 0 ? log.length : read).filter((e) => e.kind === "pay");
    return pays.length >= 2;
  };

  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/mail/links", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  /** Another change landing just before each write, as large as the one there. */
  const another = (key: string, make: (i: number) => string, lose?: number) => {
    let writes = 0;
    return async (): Promise<"lose" | void> => {
      writes += 1;
      await pipeline([["SET", key, make(writes), "EX", 86_400]]);
      if (lose === writes) return "lose";
    };
  };

  // ---------------------------------------------------------------- part 1
  part("1. The whole change request at its worst, against the studio requests taken");
  const to = longest(3, 99);
  is("the address is at its longest in characters", to.length <= SENT_LINK_MAX_LENGTH && to.length > SENT_LINK_MAX_LENGTH - 3, true);
  is("and the rules let it go there", destinationProblem(to, linksOf(worst.body)[3], store), null);
  const key = sentLinkKey(worst.id);
  const cases: [string, () => Promise<void>, (answer: { status: number; body: Record<string, unknown> }) => boolean][] = [
    ["saved", async () => {}, (a) => a.status === 200 && a.body.ok === true],
    ["busy: every write finds another change first", async () => {
      interlope = another(key, (i) => history(SENT_LINK_CHANGES_MAX - 1, now + 300 * 86_400, 1_000 * i));
    }, (a) => a.status === 409 && a.body.error === "busy"],
    ["the second write's answer lost, read back", async () => {
      interlope = another(key, (i) => history(SENT_LINK_CHANGES_MAX - 1, now + 300 * 86_400, 1_000 * i), 2);
    }, (a) => a.status === 503 && a.body.error === "unconfirmed"],
    ["a full history", async () => {
      await pipeline([["SET", key, history(SENT_LINK_CHANGES_MAX), "EX", 86_400]]);
    }, (a) => a.status === 400 && a.body.error === "full"],
    ["a first change that meets another's new history, kept a second longer", async () => {
      await pipeline([["DEL", key]]);
      interlope = another(key, (i) => history(SENT_LINK_CHANGES_MAX - 1, now + 400 * 86_400 + 5 + i, 1_000 * i));
    }, (a) => a.status === 409 && a.body.error === "busy"],
  ];
  for (const [what, arrange, expected] of cases) {
    await pipeline([["SET", key, almost, "EX", 86_400]]);
    await arrange();
    const pending = interlope;
    watch();
    interlope = pending;
    const answer = await post({ action: "link-change", id: worst.id, n: 3, to });
    const log = events;
    unwatch();
    const sum = covered(log);
    is(`${what}: answered as it should (${answer.status} ${String(answer.body.error ?? "ok")})`, expected(answer), true);
    is(`${what}: every command and byte inside the studio requests taken when sent (${JSON.stringify(sum)})`, sum.ok, true);
    is(`${what}: the change's own studio requests are taken before the email or its history is read`, paidBeforeReading(log, worst.id), true);
  }

  part("1b. Without the studio requests a change needs, the email and its history are not read");
  {
    await pipeline([["SET", key, almost, "EX", 86_400]]);
    const allowance = redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
    is("the store's studio count is where the route counts it", allowance.length, 1);
    await pipeline([["SET", allowance[0], String(5_000 - 2)]]);
    watch();
    const answer = await post({ action: "link-change", id: worst.id, n: 3, to });
    const log = events;
    unwatch();
    const read = log.some((e) => e.kind === "db" && e.reads.some((k) => k === `nl:mail:bc:${worst.id}` || k === key));
    is("refused for the studio requests, in words", [answer.status, answer.body.error, typeof answer.body.message === "string" && String(answer.body.message).length > 10], [429, "studio_used", true]);
    is("neither the email nor its history was read", read, false);
    is("its history is as it was", (await readSentLinks(worst.id))?.changes.length, SENT_LINK_CHANGES_MAX - 1);
    await pipeline([["SET", allowance[0], "0"]]);
  }

  // ---------------------------------------------------------------- part 2
  part("2. The history's ceiling in UTF-8 bytes, checked before writing");
  const max = (rules as Record<string, unknown>).SENT_LINK_RECORD_MAX_BYTES;
  is("the ceiling is a number of bytes", typeof max === "number" && Number.isSafeInteger(max) && (max as number) > 0, true);
  const ceiling = typeof max === "number" ? max : 0;
  for (const [what, unit] of [["three-byte characters", "中"], ["four-byte pairs", "\u{1F600}"]] as const) {
    const fresh = await makeSent(`Fill ${what}`);
    const answers: boolean[] = [];
    for (let k = 0; k < SENT_LINK_CHANGES_MAX; k += 1) answers.push((await changeLink(store, fresh.email, 5, longest(5, k, unit))).ok);
    const [raw] = (await pipeline([["GET", sentLinkKey(fresh.id)]])) as string[];
    is(`${what}: every change at its longest is saved`, answers, answers.map(() => true));
    is(`${what}: the history written is inside the ceiling (${utf8(raw)} bytes of ${ceiling})`, utf8(raw) <= ceiling, true);
  }
  const lone = `https://youtube.com/watch?v=5&q=${"\ud800".repeat(900)}`;
  is("an address with a lone surrogate (six bytes once written) is refused by the rules", destinationProblem(lone, linksOf(worst.body)[5], store) !== null, true);
  {
    const fresh = await makeSent("Lone surrogates");
    const answer = await changeLink(store, fresh.email, 5, lone);
    is("and by the server, with nothing written", [answer.ok, !answer.ok && answer.reason, await readSentLinks(fresh.id)], [false, "to", null]);
  }
  {
    // A history written past the ceiling (by a version before it was checked): a change more is never written.
    const fresh = await makeSent("Past the ceiling");
    const past = JSON.stringify({ l: store.listId, exp: now + 300 * 86_400, changes: Array.from({ length: SENT_LINK_CHANGES_MAX - 1 }, (_, i) => ({ n: 5, to: `https://youtube.com/watch?v=${i}&q=${"\ud800".repeat(960)}`, at: now })) });
    await pipeline([["SET", sentLinkKey(fresh.id), past, "EX", 86_400]]);
    is("that history is past the ceiling", utf8(past) > ceiling, true);
    const answer = await changeLink(store, fresh.email, 5, "https://youtube.com/watch?v=ok");
    const [after] = (await pipeline([["GET", sentLinkKey(fresh.id)]])) as string[];
    is("a change more is refused in words, and nothing is written", [answer.ok, !answer.ok && answer.message.length > 10, after === past], [false, true, true]);
  }

  // ---------------------------------------------------------------- part 3
  part("3. One opening of a link, with the history at its longest");
  {
    const opened = await makeSent("Opened");
    const full = JSON.stringify({ l: store.listId, exp: now + 300 * 86_400, changes: Array.from({ length: SENT_LINK_CHANGES_MAX }, (_, i) => ({ n: 19, to: longest(19, i), at: now })) });
    await pipeline([["SET", sentLinkKey(opened.id), full, "EX", 86_400]]);
    is("the history is at its longest in bytes", utf8(full) > 55_000, true);
    const href = linksOf(opened.body)[19];
    const signed = sentLinksFor(store.handle, opened.id, broadcastCampaign(opened.id), opened.body)!(href, href);
    const url = new URL(signed);
    const parts = url.pathname.split("/");
    watch();
    let response: Response | null = null;
    try {
      response = await GET(new Request(url), { params: Promise.resolve({ handle: decodeURIComponent(parts[2]), id: parts[3], link: parts[4] }) });
    } catch (error) {
      // An address with letters outside ASCII cannot be a Location header as it is: the redirect must never fail for it.
      console.error("the redirect threw", error);
    }
    const log = events;
    unwatch();
    const location = response?.headers.get("location") ?? "";
    is("an address with letters outside ASCII is answered with a redirect, its Location in ASCII", [response?.status ?? "threw", /^[\x21-\x7e]+$/.test(location)], [302, true]);
    const q = (address: string) => {
      try {
        return new URL(address).searchParams.get("q");
      } catch {
        return null;
      }
    };
    is("it goes where the last change says", q(location), q(currentOf(JSON.parse(full).changes, 19)!));
    const db = log.filter((e): e is Extract<Event, { kind: "db" }> => e.kind === "db");
    const commands = db.reduce((n, e) => n + e.commands, 0);
    const bytes = db.reduce((n, e) => n + e.bytes, 0);
    const out = utf8(location) + 512;
    const reads = db.flatMap((e) => e.reads.map((k) => k.replace(opened.id, "<id>").replace(/[0-9a-f]{24,}/g, "<x>")));
    const read = { commands, bytes, out, reads };
    is(`what it reads: the store, its count and the history, once each (${JSON.stringify(read)})`, reads.filter((k) => k.endsWith(":go")).length, 1);
    is(`and it costs less than the public request it is counted as (${(SENT_LINK_REQUEST_UNITS * laterPageCost()).toExponential(3)} against ${(costOf("light", commands, bytes) + out * ORIGIN_PER_BYTE).toExponential(3)})`, SENT_LINK_REQUEST_UNITS * laterPageCost() >= costOf("light", commands, bytes) + out * ORIGIN_PER_BYTE, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
