/**
 * A test meeting, made on the account a creator has just connected.
 *
 * Connecting Google Calendar or Zoom says only that the provider let us in.
 * Whether a meeting is really made there shows the first time somebody
 * books a call, which is the worst moment to find out that it is not. So the
 * Video calls page has a button: it makes one meeting on the connected
 * account, an hour from now, with nobody invited, shows its link, moves it an
 * hour later when asked — what a buyer's move does — and takes it away again. It is made with the same calls a booking's
 * meeting is made with (lib/meet-providers.ts), so what it proves is the
 * thing itself.
 *
 * One at a time for each account, and forgotten with the connection it was
 * made on (lib/meet-connect.ts, testKey): the meeting itself stays on the
 * creator's account until they delete it, here or there, like every meeting
 * we make. Its record is written only through keepTest (lib/meet-connect.ts),
 * so a deletion confirmed while one is being made or moved (Zoom's notice that
 * the app was removed, Disconnect, Delete) is never undone by the write that
 * follows it.
 */
import { randomBytes } from "node:crypto";
import type { Store } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import type { MeetProvider } from "@/lib/call-setup";
import { ACCOUNT_NAMES, accessFor, keepTest, testKey, NotConnected } from "@/lib/meet-connect";
import { eventId, googleCreate, googleDelete, googleMove, zoomCreate, zoomDelete, zoomMove } from "@/lib/meet-providers";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

export class TestMeetingUnavailable extends Error {
  constructor() { super("The test meeting could not be changed just now. Try again in a moment."); }
}

export type TestMeeting = { id: string; link: string; start: number; end: number; madeAt: number };

/** How long the test meeting is set for. Nobody has to join it. */
export const TEST_MEETING_MINUTES = 30;
export const TEST_MEETING_TITLE = "Marktmorgen test meeting";

/**
 * A test meeting as kept: null when the slot answered null (none there).
 * Any other reply, or a record without its id, its https link or its times,
 * is unknown (CX-123 rule 24) and throws, so nothing is offered, made, moved
 * or deleted as if there were none.
 */
function parse(raw: unknown): TestMeeting | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw unread("a test meeting that is not text");
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw unread("a test meeting that is not a record");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw unread("a test meeting that is not a record");
  const { id, link, start, end, madeAt } = v as Record<string, unknown>;
  const time = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (typeof id !== "string" || !id || typeof link !== "string" || !/^https:\/\//.test(link) || !time(start) || !time(end) || !time(madeAt)) {
    throw unread("a test meeting record without its id, link or times");
  }
  return { id, link, start: start as number, end: end as number, madeAt: madeAt as number };
}

/** Logged once where it is found; the caller says "could not be read or changed just now". */
function unread(what: string): TestMeetingUnavailable {
  console.error(`Redis answered ${what}`);
  return new TestMeetingUnavailable();
}

/**
 * The test meeting each of these accounts has, where it has one. Throws
 * TestMeetingUnavailable when any reply is not in its exact shape: the Video
 * calls page then says it could not read the test meeting, and the route
 * answers "try again in a moment".
 */
export async function readTests(statsId: string | null, providers: MeetProvider[]): Promise<Partial<Record<MeetProvider, TestMeeting>>> {
  const kept = await readKept(statsId, providers);
  const found: Partial<Record<MeetProvider, TestMeeting>> = {};
  for (const p of providers) {
    const one = kept[p];
    if (one) found[p] = one.test;
  }
  return found;
}

/** As readTests, with each record's text as it was read, for keepTest to write over only that one. */
async function readKept(statsId: string | null, providers: MeetProvider[]): Promise<Partial<Record<MeetProvider, { test: TestMeeting; raw: string }>>> {
  if (!statsId || !providers.length || !isRedisConfigured()) return {};
  const replies = repliesFor(await redisPipeline(providers.map((p) => ["GET", testKey(statsId, p)])), providers.length);
  if (!replies) throw unread("the test meetings with a reply missing or extra");
  const found: Partial<Record<MeetProvider, { test: TestMeeting; raw: string }>> = {};
  providers.forEach((p, i) => {
    const test = parse(replies[i]);
    if (test) found[p] = { test, raw: replies[i] as string };
  });
  return found;
}

/**
 * Keeps the record made or moved, only while the connection it was made on is still there and no deletion of its
 * account was confirmed since `began`, and only over the record as it was read (lib/meet-connect.ts keepTest). A
 * connection deleted meanwhile throws NotConnected (the route says "not connected"); a reply not one of the script's
 * is unknown (CX-123 rule 24) and throws TestMeetingUnavailable, never taken as kept. Otherwise says whether it was
 * kept, or the record changed meanwhile (or the make or move ran too long), with nothing written.
 */
async function keep(statsId: string, provider: MeetProvider, account: string, began: number, test: TestMeeting, had: string | null): Promise<boolean> {
  const kept = await keepTest(statsId, provider, { account, startedAt: began, value: JSON.stringify(test), had });
  if (kept === "unknown") throw unread("keeping the test meeting with a reply that is not one of the script's");
  if (kept === "gone") throw new NotConnected(`${ACCOUNT_NAMES[provider]} is not connected`);
  return kept === "kept";
}

/**
 * Makes the test meeting, or gives back the one already there. Throws what
 * the connection or the provider throws (NotConnected, ProviderError), for
 * the route to say in words.
 */
export async function makeTest(store: Store, provider: MeetProvider, now = Date.now()): Promise<TestMeeting> {
  // When this make began, for keepTest: a deletion of the account confirmed after it keeps nothing it makes.
  const began = Date.now();
  const statsId = store.statsId;
  if (!statsId) throw new NotConnected("Connect an account first.");
  const had = (await readTests(statsId, [provider]))[provider];
  if (had) return had;
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) throw new TestMeetingUnavailable();
  const access = await accessFor(statsId, provider);
  // An hour from now, on the next five minutes: far enough not to ring anybody's phone as "starting".
  const start = Math.ceil((now + 3_600_000) / 300_000) * 300_000;
  const end = start + TEST_MEETING_MINUTES * 60_000;
  const spec = {
    eventId: eventId(`test|${statsId}|${randomBytes(6).toString("hex")}`),
    title: TEST_MEETING_TITLE,
    // A meeting made here may end up with no record (the connection gone meanwhile, a keep reply not the script's), so
    // the studio's page would not list it: the words say where to delete it then, never only that page.
    description: `Made from your Marktmorgen studio to check that the connection works. Nobody is invited. You can delete it from the Video calls page in your studio. If that page doesn't list it, delete it in ${ACCOUNT_NAMES[provider]}.`,
    start,
    end,
    tz: "UTC",
    guests: [],
    group: false,
  };
  const meeting = provider === "zoom" ? await zoomCreate(access.token, spec) : await googleCreate(access.token, spec);
  const test: TestMeeting = { id: meeting.id, link: meeting.link, start, end, madeAt: now };
  // Kept only while the connection is still there and nothing was made meanwhile. Before, a plain SET wrote it after
  // a deletion confirmed during the call above (Zoom's notice, Disconnect), or over a test meeting made meanwhile.
  if (!(await keep(statsId, provider, access.account, began, test, null))) {
    // Another one was made meanwhile (or this ran too long): the one made here is not left behind on the account.
    if (provider === "zoom") await zoomDelete(access.token, meeting.id).catch(() => {});
    else await googleDelete(access.token, meeting.id).catch(() => {});
    throw new TestMeetingUnavailable();
  }
  return test;
}

/** How far the test meeting is moved: the same hour a buyer's move would. */
export const TEST_MOVE_MINUTES = 60;

/**
 * Moves the test meeting an hour later on the creator's account, with the
 * same call a booking's meeting is moved with when its buyer picks another
 * time (lib/meet-links.ts). Null when there is no test meeting to move.
 */
export async function moveTest(store: Store, provider: MeetProvider): Promise<TestMeeting | null> {
  const began = Date.now();
  const statsId = store.statsId;
  if (!statsId) return null;
  const read = (await readKept(statsId, [provider]))[provider];
  if (!read) return null;
  const had = read.test;
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) throw new TestMeetingUnavailable();
  const access = await accessFor(statsId, provider);
  const shift = TEST_MOVE_MINUTES * 60_000;
  const when = { start: had.start + shift, end: had.end + shift, tz: "UTC" };
  if (provider === "zoom") await zoomMove(access.token, had.id, when);
  else await googleMove(access.token, had.id, when);
  const moved: TestMeeting = { ...had, start: when.start, end: when.end };
  // Written back only over the record read, while the connection is still there: a test meeting deleted meanwhile
  // (Delete, Disconnect, Zoom's notice) is not shown again.
  if (!(await keep(statsId, provider, access.account, began, moved, read.raw))) throw new TestMeetingUnavailable();
  return moved;
}

/** Deletes the test meeting on the creator's account, and forgets it. False when there was none. */
export async function removeTest(statsId: string, provider: MeetProvider): Promise<boolean> {
  const had = (await readTests(statsId, [provider]))[provider];
  if (!had) return false;
  const access = await accessFor(statsId, provider);
  if (provider === "zoom") await zoomDelete(access.token, had.id);
  else await googleDelete(access.token, had.id);
  await redisPipeline([["DEL", testKey(statsId, provider)]]);
  return true;
}
