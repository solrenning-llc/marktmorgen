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
 * we make.
 */
import { randomBytes } from "node:crypto";
import type { Store } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import type { MeetProvider } from "@/lib/call-setup";
import { accessFor, testKey, NotConnected } from "@/lib/meet-connect";
import { eventId, googleCreate, googleDelete, googleMove, zoomCreate, zoomDelete, zoomMove } from "@/lib/meet-providers";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

export class TestMeetingUnavailable extends Error {
  constructor() { super("The test meeting could not be changed just now. Try again in a moment."); }
}

export type TestMeeting = { id: string; link: string; start: number; end: number; madeAt: number };

/** How long the test meeting is set for. Nobody has to join it. */
export const TEST_MEETING_MINUTES = 30;
export const TEST_MEETING_TITLE = "Marktmorgen test meeting";

/**
 * The record as it was written, or null only for Redis's own "no such key" (CX-123 rule 24). Any other reply is
 * unknown and throws: read as "none", makeTest would make a second real meeting over the first one's record (the
 * first left on the creator's account out of the studio's reach), and removeTest would delete nothing.
 */
function parse(raw: unknown): TestMeeting | null {
  if (raw === null) return null;
  let v: Partial<TestMeeting> | null = null;
  try {
    if (typeof raw === "string") v = JSON.parse(raw) as Partial<TestMeeting>;
  } catch {
    v = null;
  }
  const time = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || typeof v.link !== "string" || !/^https:\/\//.test(v.link) || !time(v.start) || !time(v.end) || !time(v.madeAt)) {
    throw new UnknownReplyError("a test meeting");
  }
  return { id: v.id, link: v.link, start: v.start, end: v.end, madeAt: v.madeAt };
}

/** The test meeting each of these accounts has, where it has one. Throws UnknownReplyError on any other reply. */
export async function readTests(statsId: string | null, providers: MeetProvider[]): Promise<Partial<Record<MeetProvider, TestMeeting>>> {
  if (!statsId || !providers.length || !isRedisConfigured()) return {};
  const replies = repliesFor(await redisPipeline(providers.map((p) => ["GET", testKey(statsId, p)])), providers.length);
  if (!replies) throw new UnknownReplyError("the test meetings");
  const found: Partial<Record<MeetProvider, TestMeeting>> = {};
  providers.forEach((p, i) => {
    const test = parse(replies[i]);
    if (test) found[p] = test;
  });
  return found;
}

/**
 * Makes the test meeting, or gives back the one already there. Throws what
 * the connection or the provider throws (NotConnected, ProviderError), for
 * the route to say in words.
 */
export async function makeTest(store: Store, provider: MeetProvider, now = Date.now()): Promise<TestMeeting> {
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
    description: "Made from your Marktmorgen studio to check that the connection works. Nobody is invited. You can delete it from the Video calls page in your studio.",
    start,
    end,
    tz: "UTC",
    guests: [],
    group: false,
  };
  const meeting = provider === "zoom" ? await zoomCreate(access.token, spec) : await googleCreate(access.token, spec);
  const test: TestMeeting = { id: meeting.id, link: meeting.link, start, end, madeAt: now };
  await redisPipeline([["SET", testKey(statsId, provider), JSON.stringify(test)]]);
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
  const statsId = store.statsId;
  if (!statsId) return null;
  const had = (await readTests(statsId, [provider]))[provider];
  if (!had) return null;
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) throw new TestMeetingUnavailable();
  const access = await accessFor(statsId, provider);
  const shift = TEST_MOVE_MINUTES * 60_000;
  const when = { start: had.start + shift, end: had.end + shift, tz: "UTC" };
  if (provider === "zoom") await zoomMove(access.token, had.id, when);
  else await googleMove(access.token, had.id, when);
  const moved: TestMeeting = { ...had, start: when.start, end: when.end };
  await redisPipeline([["SET", testKey(statsId, provider), JSON.stringify(moved)]]);
  return moved;
}

/** Deletes the test meeting on the creator's account, and forgets it. False when there was none. */
export async function removeTest(statsId: string, provider: MeetProvider): Promise<boolean> {
  const had = (await readTests(statsId, [provider]))[provider];
  if (!had) return false;
  const access = await accessFor(statsId, provider);
  if (provider === "zoom") await zoomDelete(access.token, had.id);
  else await googleDelete(access.token, had.id);
  // Read as written: a lost reply is said as not done; asking again deletes the same meeting (a 404 there is done).
  if (countOf(repliesFor(await redisPipeline([["DEL", testKey(statsId, provider)]]), 1)?.[0]) === null) throw new UnknownReplyError("forgetting the test meeting");
  return true;
}
