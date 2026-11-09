/**
 * Reading who an email would reach, paid by what the read moves.
 *
 * The composer's "count" and a broadcast written down read the store's whole
 * list (lib/contacts.ts audience), page after page. One studio request is
 * priced at twenty-odd commands and fifty kilobytes (tests/plan-cost-registry.ts,
 * UNIT_COST.studio), so a list of 5,000 people (3.7 MB) moved seventy times
 * what its one request pays for, and a list that fills the data room, a
 * hundred times more, at every change of the audience in the composer.
 *
 * So, as the buyers' ledger is counted (lib/segments.ts): the list's size is
 * read exactly first (HLEN; any other reply is unknown and nothing is read),
 * the studio requests for the most that many people can weigh are taken
 * before the first page is read (refused with the studio's sentence, nothing
 * read, when they are not there), and once it is read they are settled at
 * what it really moved, a megabyte a request after the request's own fifty
 * kilobytes: the difference given back, or counted past the figure when a
 * record weighed more than the most expected (never refused after the read).
 *
 * The scheduled job's own read of the list when an email goes out
 * (lib/broadcasts.ts advanceBroadcast) is paid by the sending it is for.
 */
import { type Who, audience, leadsKey } from "@/lib/contacts";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { IncludedBytes, STUDIO_UNIT_SENT_BYTES } from "@/lib/sent-bytes";

/**
 * The most one person's record is expected to weigh as it is read, in bytes
 * (tests/plan-cost-registry.ts, AUDIENCE_READ): the address (254), twenty
 * titles of 120 characters, twenty product ids, ten labels of 40, a name of
 * 100, the unsubscribe token and the record's other fields, with the page's
 * framing. Taken before the read, settled at what was really moved.
 */
export const CONTACT_READ_BYTES = 4_600;

/** What takes studio requests before a read: lib/studio-route.ts holdStudio, or a stand-in in a test. */
export type StudioHold = (units: number) => Promise<
  { ok: true; give: (n: number) => Promise<void>; force: (n: number) => Promise<void> } | { ok: false; message: string }
>;

/** The studio requests could not be taken, so nothing was read; `message` is the sentence to show. */
export class AudienceNotCounted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceNotCounted";
  }
}

/** Studio requests moving `bytes` costs beyond the request's own fifty kilobytes: a megabyte a request. */
export const audienceUnits = (bytes: number): number => new IncludedBytes().take(bytes, STUDIO_UNIT_SENT_BYTES).units;

/** The studio requests reading `people` people costs at the most, before it is read. */
export const audienceHeldUnits = (people: number): number => audienceUnits(people * CONTACT_READ_BYTES);

/** The size of the store's list, read exactly. Throws UnknownReplyError for any other reply: never "empty". */
export async function listSize(listId: string): Promise<number> {
  const size = countOf(repliesFor(await redisPipeline([["HLEN", leadsKey(listId)]]), 1)?.[0]);
  if (size === null) throw new UnknownReplyError("the size of a store's list");
  return size;
}

/**
 * `audience` (lib/contacts.ts), counted: the studio requests for the list's
 * size are taken through `hold` before any page is read, and settled at what
 * was moved. Throws AudienceNotCounted when they are not there.
 */
export async function countedAudience(
  hold: StudioHold,
  listId: string,
  productId?: string,
  notProductId?: string,
  who?: { kind: Who; paid: ReadonlySet<string> },
  keep?: (email: string) => boolean,
  label?: string,
): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const held = audienceHeldUnits(await listSize(listId));
  const taken = held > 0 ? await hold(held) : null;
  if (taken && !taken.ok) throw new AudienceNotCounted(taken.message);
  const moved = { bytes: 0 };
  try {
    return await audience(listId, productId, notProductId, who, keep, label, moved);
  } finally {
    // Settled at what was moved, also when the read failed halfway: the pages that came were paid for.
    const owed = audienceUnits(moved.bytes);
    if (taken && owed < held) await taken.give(held - owed).catch(() => undefined);
    else if (owed > held) {
      // More than was held: counted past it (the read is done and is not refused); with nothing held, taken now.
      if (taken) await taken.force(owed - held).catch(() => undefined);
      else await hold(owed).catch(() => null);
    }
  }
}
