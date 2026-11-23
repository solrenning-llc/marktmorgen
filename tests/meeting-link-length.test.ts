/**
 * Board #5285, row #2514 (Codex X6's LOW on #2514, 6952421939): a meeting link longer than 600 characters was stored
 * whole but read back cut at 600 (lib/meet-records.ts parseRecord), and every reader requires the stored value to equal
 * the parsed one (readRecords here, storedMeetingLink in lib/call-rooms.ts), so the record, and with it every booking's
 * room on the calls page, became unreadable. Nothing stopped a writer storing one: a Zoom join_url with a long host
 * passed ZOOM_LINK, and a creator's own link, kept by cleanRoom at 500 characters, can pass 600 once percent-encoded.
 *
 * The readers also run the link through cleanRoom, which cuts it at MAX_ROOM_LENGTH (500) before parsing it, so a
 * link of 501 to 600 characters whose host runs past the cut (a long Zoom host) was unreadable too.
 *
 * Now one test, keepsMeetingLink (lib/call-setup.ts), is what every reader accepts, and every writer uses it:
 * writeRecord refuses a link it could not read back, a provider link that fails it is refused like an answer without
 * a link, and a fallback that fails it is not given in the record.
 *
 * Synthetic records, a stand-in Zoom answer and the in-memory Redis of tests/redis-stub.ts.
 */
import * as callSetup from "@/lib/call-setup";
import { cleanRoom } from "@/lib/call-setup";
import { readRecord, recordKey, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { zoomCreate } from "@/lib/meet-providers";
import { meetingFor } from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const READER_KEEPS = 600;
const scope = "c:link-length:b:cs_test_link_length_000000000000000";
const base: MeetRecord = {
  provider: "zoom", scope, statsId: "stats-link-length", handle: "linklength", callsId: "calls-link-length", product: "call",
  session: "cs_test_link_length_000000000000000", group: false, id: "123456789", account: "host@example.com", link: "",
  made: true, start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, tz: "UTC", title: "A call", guests: [], added: [],
  todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
};
/** A Zoom join link that ZOOM_LINK accepts, exactly `length` characters long, its length in the host. */
const zoomLink = (length: number) => {
  const tail = ".zoom.us/j/123456789";
  return `https://${"a".repeat(length - "https://".length - tail.length)}${tail}`;
};
/** A link of exactly `length` characters whose length is in its query, so the 500-character cut still parses. */
const queryLink = (length: number) => `https://example.com/?q=${"a".repeat(length - "https://example.com/?q=".length)}`;
const held = () => redis.run(["GET", recordKey(scope)]);

async function main(): Promise<void> {
  part("One bound for the reader and the writers");
  is("MEET_LINK_MAX is the 600 characters the reader keeps", (callSetup as Record<string, unknown>).MEET_LINK_MAX, READER_KEEPS);

  part("A record whose link the readers accept reads back whole");
  for (const [label, link] of [["a usual Zoom link", "https://us02web.zoom.us/j/123456789?pwd=abcDEF123"], ["600 characters, the length in the query", queryLink(READER_KEEPS)]] as const) {
    redis.clear();
    const fits = { ...base, link };
    await writeRecord(fits);
    is(`${label}: read back as written`, await readRecord(scope), fits);
  }

  part("A link the readers would not read back is never stored");
  for (const [label, link] of [
    ["601 characters", queryLink(READER_KEEPS + 1)],
    ["550 characters whose host runs past the 500-character cut", zoomLink(550)],
  ] as const) {
    redis.clear();
    const refused = await writeRecord({ ...base, link }).then(() => "stored", (error: unknown) => (error instanceof Error ? "refused" : "?"));
    is(`${label}: writeRecord refuses it`, refused, "refused");
    is(`${label}: nothing is left that would read as unreadable`, held(), null);
  }

  part("A Zoom answer whose join link a record could not keep is an answer without a link");
  const realFetch = globalThis.fetch;
  try {
    for (const [label, link, expected] of [
      ["a usual one", "https://us02web.zoom.us/j/123456789?pwd=abcDEF123", "made"],
      ["550 characters, its host past the cut", zoomLink(550), "bad"],
      ["601 characters", zoomLink(READER_KEEPS + 1), "bad"],
    ] as const) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ id: 123456789, join_url: link }), { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch;
      const outcome = await zoomCreate("synthetic-token", { eventId: "x", title: "A call", description: "", start: base.start, end: base.end, tz: "UTC", guests: [], group: false })
        .then((meeting) => (meeting.link === link ? "made" : "changed"), (error: unknown) => (error instanceof Error && /without a join link/.test(error.message) ? "bad" : String(error)));
      is(`a join link, ${label}: ${expected}`, outcome, expected);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  part("A creator's own link that grows past 600 once encoded is not given in the record");
  const own = cleanRoom(`https://example.com/${"é".repeat(100)}`);
  is("cleanRoom keeps it (120 characters typed) and it grows past 600", typeof own === "string" && own !== "bad" && own.length > READER_KEEPS, true);
  redis.clear();
  const ask = {
    store: { statsId: base.statsId, handle: base.handle, callsId: base.callsId },
    provider: "zoom" as const, scope, group: false, product: "call", session: base.session, title: "A call", description: "",
    start: base.start, end: base.end, tz: "UTC", guest: null,
    fallback: async () => own as string,
  } as unknown as Parameters<typeof meetingFor>[0];
  const made = await meetingFor(ask);
  is("the meeting could not be made, and the record gives no link", [made.made, made.link], [false, ""]);
  const read = await readRecord(scope).then((record) => record?.link ?? null, () => "unreadable");
  is("the stored record reads back (the pages then show the creator's own link from the setup)", read, "");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
